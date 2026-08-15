// dsh-update-check 浏览器 half（手写 bundle，官方 __ModuleLoader__.load 契约）：
//
// 功能：设置页新增「关于」栏位 ——
//   1. 展示本地 DSH 版本与环境信息（安装目录 / DSH_HOME / Node / 进程）；
//   2. 「检测更新」按钮：经 host 同源端点代理查询 npm registry dist-tags，
//      对比当前版本，给出「已是最新 / 发现新版本 + 升级命令」结论；
//   3. 上次检测结果经 host 端点持久化（<DSH_HOME>/data/dsh-update-check.json），
//      展示「上次检查」；
//   4. 一键复制升级命令，npm 页面新窗口直达。
//
// 架构（additive，不替换任何官方 UI）：
//   settings.section —— 「关于」页面（label 双语跟随页面语言）。
// 依赖：仅 react（平台模块表）+ slots/locale（client 运行时核心服务），
// 零其它 RPC；网络请求全部走同源端点（规避 CORS 不确定性）。
// 说明：不用 settingsScope 持久化——官方 WEB_SETTINGS_NAMESPACES 白名单
// 不含本插件命名空间（RPC 会以 settings-not-exposed 拒绝），改用 host
// 独立 JSON 文件，热装配即可用。

window.__ModuleLoader__.load({
	id: "dsh-update-check",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var h = React.createElement;

		var NS = "dsh-update-check";
		var CSS_TAG = "dsh-update-check";
		var INFO_URL = "/dsh-update-check/info";
		var CHECK_URL = "/dsh-update-check/check";
		var LAST_CHECK_URL = "/dsh-update-check/last-check";
		var DSH_PKG = "@deepseek-ai/dsh";
		var NPM_PAGE_URL = "https://www.npmjs.com/package/" + DSH_PKG;

		// ---------------- 版本比较（标准 semver，含 rc/beta 预发布规则） ----------------
		// "0.1.0-rc.6" → { major:0, minor:1, patch:0, pre:["rc","6"] }
		// 规则：主/次/补丁数字比较；无预发布 > 有预发布；预发布逐段比较
		// （纯数字段按数值、纯字母段按字典序、数字段 < 字母段）。
		function parseVer(s) {
			if (typeof s !== "string") return null;
			var m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s.trim());
			if (!m) return null;
			return {
				major: parseInt(m[1], 10),
				minor: parseInt(m[2], 10),
				patch: parseInt(m[3], 10),
				pre: m[4] ? m[4].split(".") : null,
			};
		}
		function cmpVer(a, b) {
			if (!a || !b) return 0;
			if (a.major !== b.major) return a.major < b.major ? -1 : 1;
			if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
			if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
			var ap = a.pre, bp = b.pre;
			if (!ap && !bp) return 0;
			if (!ap) return 1;
			if (!bp) return -1;
			var n = Math.max(ap.length, bp.length);
			for (var i = 0; i < n; i++) {
				var x = ap[i], y = bp[i];
				if (x === undefined) return -1;
				if (y === undefined) return 1;
				var xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
				if (xn && yn) {
					var nx = parseInt(x, 10), ny = parseInt(y, 10);
					if (nx !== ny) return nx < ny ? -1 : 1;
				} else if (xn) {
					return -1;
				} else if (yn) {
					return 1;
				} else if (x !== y) {
					return x < y ? -1 : 1;
				}
			}
			return 0;
		}
		function hasUpdate(latest, current) {
			var a = parseVer(latest), b = parseVer(current);
			if (!a || !b) return false;
			return cmpVer(a, b) > 0;
		}

		// ---------------- 持久化解析（host last-check 端点） ----------------
		function readPersist(v) {
			var out = {
				lastCheckAt: 0,
				lastLatest: "",
				lastNext: "",
				lastHasUpdate: false,
				lastError: "",
			};
			if (!v || typeof v !== "object") return out;
			for (var k in out) out[k] = v[k] !== undefined ? v[k] : out[k];
			return out;
		}

		// ---------------- 组件 ----------------
		function InfoRow(props) {
			return h("div", { className: "duc-row" },
				h("div", { className: "duc-rowLabel" }, props.label),
				h("div", { className: "duc-rowValue", title: props.value == null ? "" : String(props.value) },
					props.value == null || props.value === "" ? "\u2014" : String(props.value)));
		}

		function AboutPanel(props) {
			var t = props.t;

			var infoState = React.useState(null); // host 本地信息
			var info = infoState[0];
			var setInfo = infoState[1];
			var infoErrState = React.useState(false);
			var infoErr = infoErrState[0];
			var setInfoErr = infoErrState[1];

			// 检测状态机：phase idle | checking | done | error
			var phaseState = React.useState("idle");
			var phase = phaseState[0];
			var setPhase = phaseState[1];
			// 最近一次检测结果
			var resultState = React.useState(null);
			var result = resultState[0];
			var setResult = resultState[1];
			// 持久化的「上次检查」
			var persistState = React.useState(null);
			var persist = persistState[0];
			var setPersist = persistState[1];
			// 复制反馈
			var copiedState = React.useState(false);
			var copied = copiedState[0];
			var setCopied = copiedState[1];

			// 挂载：拉本地信息 + 读上次检查
			React.useEffect(function () {
				var alive = true;
				fetch(INFO_URL, { method: "GET" })
					.then(function (r) {
						if (!r.ok) throw new Error("HTTP " + r.status);
						return r.json();
					})
					.then(function (data) {
						if (alive && data && data.ok) setInfo(data);
						else if (alive) setInfoErr(true);
					})
					.catch(function () {
						if (alive) setInfoErr(true);
					});
				fetch(LAST_CHECK_URL, { method: "GET" })
					.then(function (r) {
						if (!r.ok) throw new Error("HTTP " + r.status);
						return r.json();
					})
					.then(function (data) {
						if (alive && data && data.ok && data.lastCheck) {
							setPersist(readPersist(data.lastCheck));
						}
					})
					.catch(function () { /* 读不到上次检查不阻塞 */ });
				return function () { alive = false; };
			}, []);

			// 写入持久化（host JSON 文件；失败不阻塞 UI）
			function writePersist(partial) {
				var merged = readPersist(partial);
				setPersist(merged);
				try {
					fetch(LAST_CHECK_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(merged),
					}).catch(function (err) {
						console.error("[dsh-update-check] persist failed", err);
					});
				} catch (e) {
					console.error("[dsh-update-check] persist threw", e);
				}
			}

			// 检测更新
			function checkNow() {
				if (phase === "checking") return;
				setPhase("checking");
				setCopied(false);
				fetch(CHECK_URL, { method: "GET" })
					.then(function (r) {
						if (!r.ok) throw new Error("HTTP " + r.status);
						return r.json();
					})
					.then(function (data) {
						if (!data || !data.ok) {
							var errMsg = data && data.error ? data.error : "未知错误";
							setResult({ ok: false, error: errMsg });
							setPhase("error");
							writePersist({ lastCheckAt: Date.now(), lastError: errMsg });
							return;
						}
						var latest = data.latest;
						var cur = info && info.version ? info.version : null;
						var upd = cur ? hasUpdate(latest, cur) : false;
						setResult({ ok: true, latest: latest, next: data.next, hasUpdate: upd, current: cur });
						setPhase("done");
						writePersist({
							lastCheckAt: Date.now(),
							lastLatest: latest,
							lastNext: data.next || "",
							lastHasUpdate: upd,
							lastError: "",
						});
					})
					.catch(function (err) {
						var msg = err && err.message ? err.message : "网络错误";
						setResult({ ok: false, error: msg });
						setPhase("error");
						writePersist({ lastCheckAt: Date.now(), lastError: msg });
					});
			}

			// 复制升级命令
			function copyCommand() {
				var cmd = info && info.updateCommand
					? info.updateCommand
					: "npm install -g " + DSH_PKG + "@latest";
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(cmd).then(
						function () { setCopied(true); },
						function () { fallbackCopy(cmd); }
					);
				} else {
					fallbackCopy(cmd);
				}
			}
			function fallbackCopy(text) {
				try {
					var ta = document.createElement("textarea");
					ta.value = text;
					ta.style.position = "fixed";
					ta.style.opacity = "0";
					document.body.appendChild(ta);
					ta.select();
					document.execCommand("copy");
					document.body.removeChild(ta);
					setCopied(true);
				} catch (e) { /* 复制失败静默 */ }
			}

			// 时间格式化
			function fmtTime(ts) {
				if (!ts) return t("duc.never");
				try {
					return new Date(ts).toLocaleString();
				} catch (e) {
					return String(ts);
				}
			}

			// ---- 横幅内容 ----
			var banner = null;
			if (phase === "checking") {
				banner = h("div", { className: "duc-banner duc-bannerInfo" },
					h("div", { className: "duc-bannerTitle" }, t("duc.checking")),
					h("div", { className: "duc-bannerDesc" }, t("duc.checkingDesc")));
			} else if (phase === "error" && result) {
				banner = h("div", { className: "duc-banner duc-bannerErr" },
					h("div", { className: "duc-bannerTitle" }, t("duc.error")),
					h("div", { className: "duc-bannerDesc" }, result.error));
			} else if (phase === "done" && result) {
				if (result.hasUpdate) {
					banner = h("div", { className: "duc-banner duc-bannerWarn" },
						h("div", { className: "duc-bannerTitle" }, t("duc.found") + " " + (result.latest ? "v" + result.latest : "")),
						h("div", { className: "duc-bannerDesc" }, t("duc.foundDesc") + "（" + t("duc.current") + " v" + result.current + "）"),
						info && info.updateCommand ? h("div", { className: "duc-cmdRow" },
							h("code", { className: "duc-cmd" }, info.updateCommand),
							h("button", {
								type: "button",
								className: "duc-btn duc-btnGhost",
								onClick: copyCommand,
							}, copied ? t("duc.copied") : t("duc.copyCmd"))) : null,
						h("a", {
							className: "duc-link",
							href: (info && info.npmPageUrl) || NPM_PAGE_URL,
							target: "_blank",
							rel: "noreferrer",
						}, t("duc.openNpm") + " \u2197"));
				} else {
					banner = h("div", { className: "duc-banner duc-bannerOk" },
						h("div", { className: "duc-bannerTitle" }, t("duc.uptodate") + (result.latest ? " v" + result.latest : "")),
						h("div", { className: "duc-bannerDesc" },
							(result.next && result.next !== result.latest ? t("duc.next") + ": v" + result.next + " · " : "") + t("duc.uptodateDesc")));
				}
			}

			// ---- 版本区（含「上次检查」快照）----
			var lastCheck = persist && persist.lastCheckAt ? persist.lastCheckAt : 0;
			var lastLatest = persist ? persist.lastLatest : "";
			var lastErrorText = persist ? persist.lastError : "";

			return h("div", { className: "duc-panel" },
				h("div", { className: "duc-hero" },
					h("div", { className: "duc-heroMain" },
						h("div", { className: "duc-heroTitle" }, t("duc.title")),
						h("div", { className: "duc-heroDesc" }, t("duc.desc"))),
					h("button", {
						type: "button",
						className: "duc-btn duc-btnPrimary" + (phase === "checking" ? " duc-btnBusy" : ""),
						onClick: checkNow,
						disabled: phase === "checking",
					}, phase === "checking" ? t("duc.checking") : (phase === "done" || phase === "error" ? t("duc.checkAgain") : t("duc.check")))),

				h("div", { className: "duc-section" },
					h("div", { className: "duc-sectionTitle" }, t("duc.version")),
					h(InfoRow, {
						label: t("duc.current"),
						value: infoErr ? t("duc.hostInfoErr") : (info && info.version ? "v" + info.version : t("duc.unknown")),
					}),
					h(InfoRow, {
						label: t("duc.latest"),
						value: result && result.ok && result.latest ? "v" + result.latest : (lastLatest ? "v" + lastLatest + "（" + t("duc.last") + "）" : t("duc.unchecked")),
					}),
					h(InfoRow, {
						label: t("duc.next"),
						value: result && result.ok && result.next ? "v" + result.next : (persist && persist.lastNext ? "v" + persist.lastNext + "（" + t("duc.last") + "）" : t("duc.unchecked")),
					}),
					banner,
					h(InfoRow, {
						label: t("duc.lastCheck"),
						value: fmtTime(lastCheck) + (phase === "error" && lastErrorText ? " · " + lastErrorText : ""),
					})),

				h("div", { className: "duc-section" },
					h("div", { className: "duc-sectionTitle" }, t("duc.env")),
					h(InfoRow, { label: t("duc.installDir"), value: info ? info.installDir : (infoErr ? t("duc.hostInfoErr") : t("duc.loading")) }),
					h(InfoRow, { label: t("duc.dshHome"), value: info ? info.dshHome : (infoErr ? t("duc.hostInfoErr") : t("duc.loading")) }),
					h(InfoRow, {
						label: t("duc.node"),
						value: info ? info.nodeVersion + " / " + info.platform + " " + info.arch : (infoErr ? t("duc.hostInfoErr") : t("duc.loading")),
					}),
					h(InfoRow, { label: t("duc.pid"), value: info ? String(info.pid) : (infoErr ? t("duc.hostInfoErr") : t("duc.loading")) }),
					h(InfoRow, {
						label: t("duc.autoUpdate"),
						value: info ? (info.autoUpdate ? "✔" : "✘") : (infoErr ? t("duc.hostInfoErr") : t("duc.loading")),
					})),

				h("div", { className: "duc-footer" },
					h("a", {
						className: "duc-link",
						href: NPM_PAGE_URL,
						target: "_blank",
						rel: "noreferrer",
					}, "npmjs.com/package/" + DSH_PKG + " \u2197")));
		}

		// ---------------- 词典 ----------------
		var zh = {
			"duc.title": "关于 DSH",
			"duc.desc": "版本与环境信息，以及更新检测。DSH 没有自动更新机制——检测到新版本后，按给出的命令手动升级。",
			"duc.check": "检测更新",
			"duc.checkAgain": "重新检测",
			"duc.checking": "正在检查最新版本…",
			"duc.checkingDesc": "正在查询 npm registry，通常只需几秒。",
			"duc.version": "版本",
			"duc.current": "当前版本",
			"duc.latest": "最新版本（latest）",
			"duc.next": "Next 版本",
			"duc.last": "上次检测",
			"duc.unchecked": "未检测",
			"duc.lastCheck": "上次检查",
			"duc.never": "尚未检查过",
			"duc.uptodate": "已是最新版本",
			"duc.uptodateDesc": "本地与 npm 最新版一致，无需更新。",
			"duc.found": "发现新版本",
			"duc.foundDesc": "本地版本落后于 npm 最新版。升级前请先备份自定义配置与插件（升级会覆盖随包自带的预设配置）。",
			"duc.copyCmd": "复制命令",
			"duc.copied": "已复制",
			"duc.openNpm": "npm 页面",
			"duc.error": "检查失败",
			"duc.env": "环境信息",
			"duc.installDir": "安装目录",
			"duc.dshHome": "DSH_HOME",
			"duc.node": "Node 环境",
			"duc.pid": "进程 PID",
			"duc.autoUpdate": "自动更新",
			"duc.loading": "读取中…",
			"duc.hostInfoErr": "获取失败",
			"duc.unknown": "未知",
		};
		var en = {
			"duc.title": "About DSH",
			"duc.desc": "Version & environment info plus update checking. DSH has no auto-update — when a new version is found, upgrade manually with the command shown.",
			"duc.check": "Check for updates",
			"duc.checkAgain": "Check again",
			"duc.checking": "Checking for updates…",
			"duc.checkingDesc": "Querying the npm registry; usually takes a few seconds.",
			"duc.version": "Version",
			"duc.current": "Current version",
			"duc.latest": "Latest (latest)",
			"duc.next": "Next",
			"duc.last": "last check",
			"duc.unchecked": "not checked",
			"duc.lastCheck": "Last check",
			"duc.never": "Never checked",
			"duc.uptodate": "Up to date",
			"duc.uptodateDesc": "Local version matches the latest on npm.",
			"duc.found": "New version available",
			"duc.foundDesc": "A newer version exists on npm. Back up your custom config and plugins before upgrading (an upgrade overwrites shipped presets).",
			"duc.copyCmd": "Copy command",
			"duc.copied": "Copied",
			"duc.openNpm": "npm page",
			"duc.error": "Check failed",
			"duc.env": "Environment",
			"duc.installDir": "Install dir",
			"duc.dshHome": "DSH_HOME",
			"duc.node": "Node",
			"duc.pid": "PID",
			"duc.autoUpdate": "Auto-update",
			"duc.loading": "Loading…",
			"duc.hostInfoErr": "Unavailable",
			"duc.unknown": "Unknown",
		};

		// ---------------- apply ----------------
		function apply(ctx) {
			// 词典
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "dsh-update-check: dictionaries");

			// 设置页「关于」栏位
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "dsh-update-check",
					order: 200,
					label: function () {
						var lang = typeof document !== "undefined" && document.documentElement ? (document.documentElement.lang || "") : "";
						return lang.toLowerCase().indexOf("en") === 0 ? "About" : "关于";
					},
					locale: NS,
				}, AboutPanel);
			});

			// 样式（仅注入一次；沿用 --dsw-alias-* 主题变量）
			var css = "" +
				".duc-panel{display:flex;flex-direction:column;gap:20px;padding:4px 2px 24px}" +
				".duc-hero{display:flex;align-items:center;gap:16px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-state-ok-primary,var(--dsw-static-deepseek-500,#4d6bfe)) 8%,transparent),transparent 55%)}" +
				".duc-heroMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}" +
				".duc-heroTitle{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}" +
				".duc-heroDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
				".duc-btn{flex:none;height:32px;padding:0 16px;border-radius:8px;border:none;font-family:inherit;font-size:13px;line-height:32px;cursor:pointer;transition:filter .12s ease,opacity .12s ease}" +
				".duc-btnPrimary{background:var(--dsw-static-deepseek-500,var(--dsw-alias-state-ok-primary));color:#fff;font-weight:500}" +
				".duc-btnPrimary:hover{filter:brightness(1.08)}" +
				".duc-btnPrimary:disabled{cursor:default;opacity:.65}" +
				".duc-btnBusy{opacity:.75}" +
				".duc-btnGhost{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:28px;height:28px;padding:0 12px;flex:none}" +
				".duc-btnGhost:hover{border-color:var(--dsw-static-deepseek-500,var(--dsw-alias-state-ok-primary));color:var(--dsw-static-deepseek-500,var(--dsw-alias-state-ok-primary))}" +
				".duc-section{display:flex;flex-direction:column;gap:2px;padding:2px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}" +
				".duc-sectionTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary);padding:14px 0 6px}" +
				".duc-row{display:flex;align-items:center;gap:16px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1);min-height:44px}" +
				".duc-row:first-of-type{border-top:none}" +
				".duc-rowLabel{flex:none;width:140px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
				".duc-rowValue{flex:1;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}" +
				".duc-banner{margin:6px 0 2px;padding:12px 14px;border-radius:10px;border:1px solid;display:flex;flex-direction:column;gap:4px}" +
				".duc-bannerTitle{font-size:13px;font-weight:600;line-height:20px}" +
				".duc-bannerDesc{font-size:12px;line-height:18px;opacity:.85;overflow-wrap:anywhere}" +
				".duc-bannerOk{border-color:color-mix(in srgb,var(--dsw-alias-state-ok-primary,#2fb344) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-ok-primary,#2fb344) 9%,transparent);color:var(--dsw-alias-state-ok-primary,#2fb344)}" +
				".duc-bannerWarn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 9%,transparent);color:var(--dsw-alias-state-warn-primary,#d97706)}" +
				".duc-bannerErr{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 9%,transparent);color:var(--dsw-alias-state-error-primary,#e5484d)}" +
				".duc-bannerInfo{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}" +
				".duc-cmdRow{display:flex;align-items:center;gap:10px;margin-top:8px}" +
				".duc-cmd{flex:1;min-width:0;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-code,color-mix(in srgb,var(--dsw-alias-bg-module-platform) 80%,#000 20%));color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:18px;overflow-wrap:anywhere}" +
				".duc-link{flex:none;font-size:12px;line-height:18px;color:var(--dsw-static-deepseek-500,var(--dsw-alias-state-ok-primary));text-decoration:none}" +
				".duc-link:hover{text-decoration:underline}" +
				".duc-footer{display:flex;justify-content:flex-end}";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + CSS_TAG + "\"]") === null) {
				var tag = document.createElement("style");
				tag.dataset.pluginCss = CSS_TAG;
				tag.textContent = css;
				document.head.appendChild(tag);
			}
		}

		exports.apply = apply;
		exports.inject = ["locale", "slots"];

		return module.exports;
	}
});

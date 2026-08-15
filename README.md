# dsh-update-check

DSH 设置页「关于」栏位 + 一键检测更新插件。

## 功能

- **设置页新增「关于」导航栏位**（additive，不替换任何官方 UI）：
  - 当前版本 / 安装目录 / DSH_HOME / Node 环境 / 进程 PID / 自动更新状态
  - **检测更新按钮**：经 host 同源端点代理查询 npm registry（`@deepseek-ai/dsh` dist-tags），
    与本地版本做标准 semver 比较（含 rc/beta 预发布规则），给出结论：
    - ✅ 已是最新版本
    - ⚠️ 发现新版本 → 显示升级命令 + 一键复制 + npm 页面直达
    - ❌ 检查失败（含原因，可重试）
  - 上次检测结果持久化在 `<DSH_HOME>/data/dsh-update-check.json`，重开设置页仍可见
- **只检测、不升级**：DSH 本身没有自动更新机制，本插件也不做任何写盘/更新操作，
  升级始终由用户在安装目录手动执行（命令一键复制）。

## 端点（host half 注册，同源）

| 端点 | 说明 |
| --- | --- |
| `GET /dsh-update-check/info` | 本地版本与环境信息 JSON（版本来源：进程启动入口 `bin.js` 上级包 `package.json`，多路径兜底） |
| `GET /dsh-update-check/check` | 代理 npm registry dist-tags，返回 `latest` / `next`（10s 超时，失败返回 `{ ok:false, error }`，HTTP 502） |
| `GET/POST /dsh-update-check/last-check` | 上次检测结果的读写（原子写 JSON 文件） |
| `GET /dsh-update-check/debug` | 诊断：settings 注册状态（仅排障用） |

> 持久化为何不走 settings 服务：官方 `dsh-host-apiproxy` 的
> `WEB_SETTINGS_NAMESPACES` 白名单硬编码了可读写命名空间，插件命名空间不在
> 白名单会被 RPC 以 `settings-not-exposed` 拒绝（改官方包需重启 dsh 才生效），
> 因此改用 host 独立 JSON 文件，热装配即可用，升级 DSH 也不受影响。

## 装配

```bash
# 运行时注入（免重启，立即生效）
# 或用 dev_install_package 热装配（同时写入 profile bundles，重启后自动装配）
```

依赖：host 侧仅 Node 内置模块 + `webServer` 服务；client 侧仅 react +
slots/locale（client 运行时核心服务）。

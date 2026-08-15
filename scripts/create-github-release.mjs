// 创建 GitHub Release v0.1.0 并上传 tgz 附件（token 不落盘不打印）
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const input = 'protocol=https\nhost=github.com\n\n'
const out = execSync('git credential fill', { input, encoding: 'utf8' })
const get = (key) => {
  const line = out.split('\n').find((x) => x.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1) : undefined
}
const token = get('password')
const user = get('username')
if (!token || !user) {
  console.error('credential 缺失')
  process.exit(1)
}
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
}
const REPO = `${user}/dsh-update-check`
const VERSION = '0.1.0'

const body = `## 🛰️ dsh-update-check — DSH 设置页「关于」栏位 + 一键检测更新

DeepSeek Harness WebUI 设置页新增「关于」页面：本地版本与环境信息一目了然，**一键检测 npm 最新版本**，发现新版本直接给出升级命令（一键复制）。

### ✨ 特性

- **关于页**（设置 → 关于，additive 注入，不替换任何官方 UI）：
  - 当前版本 / 安装目录 / DSH_HOME / Node 环境 / 进程 PID / 自动更新状态
  - 上次检测结果跨会话持久化（\`<DSH_HOME>/data/dsh-update-check.json\`）
- **检测更新**：经 host 同源端点代理查询 npm registry（\`@deepseek-ai/dsh\` dist-tags），
  与本地版本做标准 semver 比较（含 rc/beta 预发布规则），给出结论：
  - ✅ 已是最新版本
  - ⚠️ 发现新版本 → 显示升级命令 + 一键复制 + npm 页面直达
  - ❌ 检查失败（含原因，可重试）
- **只检测、不升级**：DSH 本身没有自动更新机制，本插件也不做任何写盘/更新操作，
  升级始终由用户手动执行（命令一键复制）

### 💡 无需官方包补丁

持久化不走 settings 服务（官方 \`WEB_SETTINGS_NAMESPACES\` 白名单需改官方包并重启），
改用 host 独立 JSON 文件原子写——热装配即可用，DSH 升级也不受影响。

### 📦 安装

**方式 A：tgz 直接安装（本 Release 附件）**

\`\`\`bash
# 下载 dsh-update-check-0.1.0.tgz，解压到任意插件目录（如 D:/dsh-plugins/dsh-update-check）
# 1. 运行时注入（免重启）：
#    dev_inject_plugin 指向插件目录
# 或 热装配（同时写入 profile bundles，重启后自动装配）：
#    dev_install_package 指向插件目录
# 2. 刷新浏览器页面，设置 → 关于
\`\`\`

**方式 B：git clone 安装**

\`\`\`bash
git clone https://github.com/${user}/dsh-update-check.git
cd dsh-update-check
# 其余步骤同方式 A
\`\`\`

### ✅ 兼容性

- deepseek-harness WebUI（client-modules 插件体系，slots additive 注入，零官方 UI 替换）
- host half 仅依赖 Node 内置模块 + \`webServer\` 服务；client half 仅 react + slots/locale

### 📄 License

MIT`

// 1. 创建 Release（已存在则复用）
let rel
{
  const existing = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${VERSION}`, { headers })
  if (existing.status === 200) {
    rel = await existing.json()
    console.log('release already exists:', rel.html_url)
  } else {
    const release = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tag_name: `v${VERSION}`,
        name: `v${VERSION}`,
        body,
        draft: false,
        prerelease: false,
      }),
    })
    console.log('create release:', release.status)
    rel = await release.json()
    if (release.status !== 201) {
      console.error(JSON.stringify(rel).slice(0, 500))
      process.exit(1)
    }
    console.log('release url:', rel.html_url)
  }
}

// 2. 上传 tgz 附件（asset 上传走 uploads.github.com）
const tgz = `dsh-update-check-${VERSION}.tgz`
const file = readFileSync(tgz)
const asset = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${tgz}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/gzip',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  body: file,
})
console.log('upload asset:', asset.status)
const assetBody = await asset.json().catch(() => ({}))
if (asset.status !== 201) {
  console.error(JSON.stringify(assetBody).slice(0, 400))
  process.exit(1)
}
console.log('asset:', assetBody.name, assetBody.browser_download_url)

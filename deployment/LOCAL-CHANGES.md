# 本地改动与上游更新

此仓库从上游 `bilawalsidhu/gods-eye-view` 的提交
`88b84060737a725e70183c89cbbdefad181dfb0b` 建立，保留完整 Git 历史。
`origin` 指向 [baikai55/gods-eye-view-hanhua](https://github.com/baikai55/gods-eye-view-hanhua)，
本地代码位于 `G:\github\gods-eye-view`，`main` 跟踪 `origin/main`。
`upstream` 指向原作者仓库，保留用于获取和合并更新。

## 中英文切换

主要新增代码集中在 `src/ui/i18n/`：

- `language.js`：仅支持 `en` 和 `zh-CN`，优先使用浏览器保存的选择，
  没有选择时参考浏览器语言；存储受限时仍可在当前页面切换。
- `catalog.js`：常用界面的精确英文原文与中文映射，以及允许翻译的 UI 范围。
  上游新增或改写的文案没有命中词典时直接保留英文。
- `runtime.js`：翻译文字和提示属性，维护英文恢复，观察所选 UI 范围内的动态文案；
  不修改控件、数据、图标或地图。
- `i18n.css`：右上角语言按钮与少量局部排版；手机端为按钮留出空间，
  简洁视图、录制与驾驶舱隐藏该控件。

上游文件接入点很少：`src/main.js` 安装语言控件、启动后刷新新挂载标题，并在 Vite 热更新时清理；
`src/hud.js` 让摘要请求携带当前语言，语言切换时取消旧请求并刷新；
`scripts/package-boundaries.json` 声明 HUD 的语言模块依赖。
没有批量修改上游 HTML 模板或数据源。

这是一份常用界面汉化，不承诺翻译所有数据详情、外部地点、专业来源与帮助正文。
航空/船舶标识、版权署名和未命中的文案保留原文。

## 服务端与部署

`server/providers/openai/hud-summary.js` 可配置独立的摘要服务端密钥、
API 地址、模型以及 Chat Completions 格式；摘要模型为
`z-ai/glm-5.3-flash`。有效的请求语言优先于服务器默认语言。
密钥只存在服务器的受限 `.env`，本地仓库不包含真实服务器密钥。
原有 OpenAI Responses 与无密钥备用摘要仍可用，语音保持原配置。

`deployment/`、`Dockerfile` 与 `.dockerignore` 保存已有 Cloudflare
入口适配。服务器目录为 `/opt/stacks/gods-eye-view`；域名
`map.yueming.uk` 的隧道源站仍为 `http://127.0.0.1:4173`。
`deployment/compose.yaml` 是服务器目录布局的参考文件，不能直接在仓库根运行：
它使用相邻 `source/`、`.env`、`cache/` 和 `logs/`。

`deployment/update-i18n.sh` 用于已部署服务器的这次更新：先备份当前镜像、
配置和覆盖文件，复用现有 ARM64 依赖构建；构建密钥通过 BuildKit secret
临时读取。健康检查失败时恢复原 Compose 和服务。

## 本次验证

使用 Node.js 24.19.0。生产构建、44 项语言/摘要/限流/入口定向检查、
包依赖边界通过。原有 `test:track` 在 Windows Edge 实际 GPU 下
109 项通过，测试影像为项目内置离线纹理。
Map Source/Location/Data Layers 键盘与响应式界面 gate 82 项通过；
使用独立 Vite 实例、实际 GPU、1x 设备缩放，原 gate 的断言与数据夹具保持不变。
格式检查覆盖 1,209 个源文件通过，新增测试与 CSS 的独立 Prettier 检查通过。
实际浏览器验证了英文→中文→英文恢复、未知文案回退、动态文案和提示、
刷新保存选择、首次中文 HUD 标题、折叠后提示恢复、1440/390px 按钮可点击及无遮挡。

全量单元检查报告 5,598 通过、10 跳过、1 项失败；失败是未修改的
`localReceiversProxy` DNS 计时用例，单独重跑该文件 12 项全部通过。
该次全量运行负载较高，不能把它描述为一次全绿的全量运行。
两个隔离的 Node 24 内存分配测试批次另外完成，1+13 项通过。

服务器已更新为 `gods-eye-view:88b8406-cf-i18n`，旧镜像保留为
`gods-eye-view:88b8406-cf-before-i18n`；覆盖文件、配置与镜像 ID 备份位于
`/opt/stacks/gods-eye-view/backups/i18n-20261004T063408Z`。
公网页面返回 200，中英文控件和 HUD 标题正常，两种语言摘要接口均成功，
Google 3D 仍已加载。现有 `.env` 内容与备份一致，权限仍为 600。
验证时容器约 169 MiB 内存，限制仍为 1 核/2 GiB；隧道源站端口仍为 4173。

## 后续更新建议

在没有未保存工作的分支中先获取上游更新，然后合并 `upstream/main`。
推送自己的改动使用 `origin`：

```bash
git checkout main
git fetch upstream
git merge upstream/main
# 完成下述验证后再提交、推送
git push origin main
```

发生冲突时重点检查上述少数接入点；词典通常只需要追加新的常用原文。
保留 `.env.example` 中的独立摘要配置，并重新验证 Cloudflare 入口。
正式合并之前运行项目的构建、格式、模块边界和单元检查；
实际浏览器确认中英文往返、动态图层、图标、语言偏好保存和手机布局。

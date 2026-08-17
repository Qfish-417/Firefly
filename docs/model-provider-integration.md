# FireFly 模型接入说明

## 结论

模型接入不是“任何模型名称都能直接填写”。当前锁定的 `@earendil-works/pi-ai@0.83.0` 包含 37 个静态 Provider、1153 个静态模型条目，另外注册了动态 Radius Provider。目录内、支持文本输入且凭据配置完整的模型，可以直接作为三个 Agent 的 `generate/stream` 路由。

以下情况需要额外适配：

| 类型 | 当前接入方式 |
|---|---|
| pi-ai 内置文本模型 | 直接配置 `FIREFLY_MODEL_ROUTES` 和对应 Provider 凭据 |
| OpenAI 兼容的 Ollama、vLLM、SGLang、企业代理 | pi-ai 支持自定义 Provider，但 FireFly 尚需增加受治理的自定义 Provider 配置层 |
| 非 OpenAI/Anthropic 兼容私有协议 | 实现新的 `GenerationTransport` |
| Embedding | 使用独立 `HttpEmbeddingProvider`，不经过 pi-ai 生成接口 |
| Rerank | 使用独立 `HttpRerankerProvider` |
| OCR、ASR | 使用独立受治理 HTTP Parser Provider |
| 图像生成 | 当前文本优先运行边界不启用；不能作为文本 Agent 路由 |

FireFly 当前只给模型发送文本。某个多模态模型只要同时支持文本输入，仍可以在文本模式下使用，但其视觉能力不会被调用。模型发起的 Tool Call 会被网关拒绝；工具执行必须继续通过 FireFly 的受治理工具系统。

## 三个 Agent 的选型

三个 Agent 可以使用同一个模型，也可以分别配置：

- Learning Director：优先选择便宜、延迟低、严格 JSON 稳定的模型。
- Learning Scientist：优先选择证据解释、长上下文和结构化输出更稳定的模型。
- Experience Engineer：优先选择代码能力较强的模型，但它只能给出批准路径内的 Patch Proposal，不能直接提交代码或调用工具。

推荐先使用一个 Provider 完成全链路，再增加跨 Provider 备用路由。这样能先区分 FireFly 配置问题和 Provider 差异。

## 无付费诊断

列出 Provider：

```powershell
npm run model:catalog
```

列出一个 Provider 的模型、协议、上下文、价格和输入能力：

```powershell
npm run model:catalog -- --provider deepseek
npm run model:catalog -- --provider openai
npm run model:catalog -- --provider anthropic
```

配置路由后进行启动前诊断：

```powershell
$env:FIREFLY_MODEL_ROUTES = '{"learning-director.mission-plan":[{"provider":"deepseek","model":"deepseek-v4-flash"}],"learning-scientist.analyze":[{"provider":"deepseek","model":"deepseek-v4-flash"}],"experience-engineer.patch":[{"provider":"deepseek","model":"deepseek-v4-pro"}]}'
$env:DEEPSEEK_API_KEY = "在本机环境变量中设置，不写入文件"
npm run model:doctor
```

`model:doctor` 不发送模型请求，不产生 Token 费用。它只返回：

- Provider 和模型是否存在；
- 模型是否接受文本；
- API 协议类型；
- 凭据是否配置及凭据来源名称；
- 每条主备路由是否 ready。

报告不会返回 API Key。缺少密钥时会得到 `auth_missing`，模型名过期或拼错时会得到 `model_not_found`。

## 常见凭据变量

| Provider | 环境变量 |
|---|---|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Moonshot/Kimi | `MOONSHOT_API_KEY` 或对应 Kimi Provider 凭据 |
| 智谱 | `ZAI_API_KEY` |
| xAI | `XAI_API_KEY` |
| Amazon Bedrock | 标准 AWS Profile、IAM 环境变量、任务角色或 Bedrock Bearer Token |

密钥只能进入本机环境变量、部署 Secret 或专用凭据存储，不能写入 `FIREFLY_MODEL_ROUTES`、`.env` 提交文件、Task、Prompt、日志或 Git。

## 尚未执行的真实调用

目录检查和凭据检查不代表 Provider 一定可以成功响应。真实验收还需要一次明确授权的低 Token 冒烟调用，用于验证账户余额、区域、模型权限、网络、Provider 限流和响应格式。该调用会产生外部 API 行为和潜在费用，因此不能由诊断命令隐式执行。

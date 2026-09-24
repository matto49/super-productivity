# 启用 Todo 人工工时采集（执行交接）

用户已在 todo 管理任务授权启用：Mac 在具备正常访问能力的执行环境归属活动并写人工账本，devbox 每五分钟导入原 Todo API。此文件供已经成功读取 History 的 Mac Codex 任务执行；不是要求用户运行命令。

## 现成入口

从当前运行中的 Super Productivity 检出目录执行。人工采集必须在已获授权的 Mac Codex 环境中运行；devbox 定时器只负责导入账本和写回 Todo。
运行前使用 Computer History skill，并尝试官方 `computer_history_status`。失败只记为 unknown；用户已明确授权利用该任务实际可读的已有历史，不把 unknown 伪报为 running，也不启动或修改录制设置。

```sh
python3 tools/activity-bridge/collect_human.py --config /Users/bytedance/todo-review-20260907/activity/config.json --recording-status unknown
```

若官方查询成功，最后参数使用实际 running/paused/stopped。此命令只读取配置内的 History，在原私有账本中保存任务/时间区间。不会访问 Todo API，不采集 AI 工时，不输出原始屏幕内容。原 `source` 和 AI 绑定保持不变。devbox 已有 `bridge.py --ai-only --apply` 会读取这个账本并按原 source/day 累计收据导入人工和 AI 工时。

## 完成顺序

1. 在本任务当前正常执行环境运行一次采集；如访问被拒绝，立即保留错误，不切换身份、注入进程、修改隐私设置或复制受保护目录来规避。不要用 devbox 普通 SSH 代替本环境，该路径已证实被拒绝。
2. 查看 `/Users/bytedance/todo-review-20260907/activity/human-collection.json` 和原账本，只返回任务/日期/时长汇总。检查是否有实际匹配；若为零，检查现有 ForegroundThread 对真实主面板标题的匹配，仅在 Mac 内检查最小必要事件，不输出正文。不能把整段前台时间无差别归给所有任务。
3. 重跑验证同一证据没有重复增加。随后用原 bridge.py --ai-only --apply 导入一次，并通过 tasks.py 的 API 方法 GET 对应任务，核对 source/day 收据、humanMs 和 native timeSpentOnDay。不要只凭 PUT 成功宣称完成。
4. 配置每五分钟的 Mac 人工采集步骤，优先用当前 Codex 提供的正式 automation_update 工具，并复用独立观察任务，不唤醒业务任务。此定时执行已获用户授权，不需要再次询问。先查已有定时器避免重复。devbox 保持现有主观察与 Todo 写回；不要恢复旧 ai/ai-2 全量观察。
5. 如果当前宿主没有官方调度工具，可评估普通 launchd 定时运行此 Python 入口；必须先用该定时器的实际执行身份试跑。如果被拒绝，不换身份或调整权限绕过；停止该失败定时器并明确报告需要受支持的 Mac Codex 调度入口。不能拿交互任务成功冒充定时成功。
6. 等一轮真实周期，并验证 human-collection.json 更新、devbox 定时执行、Todo API 读回。只有三项都成功才报已启用。

将脱敏结果保存到 `/Users/bytedance/todo-review-20260907/activity/activation-result.json`，字段为 status(enabled/blocked)、checkedAt、scheduler、collectorResult、apiReadbackVerified、reason。不得包含原始事件、凭证、完整会话正文。

## Computer History 不可用时的前台采样替代

`foreground_sampler.swift` 可从启用时起估算 Codex 主面板前台活动。它需要固定的 macOS App 身份获得辅助功能权限；交互任务能读取 AX，不代表 launchd 后台任务也能读取。安装脚本只编译、签名并预备 LaunchAgent，不会自行启动。用户已授权申请该权限；授权后仍须以真正的 LaunchAgent 身份验证 `foregroundStatus=observing`，再运行一轮 `bridge.py --ai-only --apply` 并从 Todo API 回读人工收据。授权未通过时保持 `permission_required`，不得将交互任务的成功当成后台启用。

采样仅在 Codex 前台、系统未空闲、主面板与 WebArea 标题一致且唯一匹配既有 `humanTitleMatch` 时归属。当前仅有两项人工标题绑定；其他 Todo 不会自动推断。它不补历史，不统计 IDE/浏览器/会议，不与原生手动计时或 AI 时长相加。详见 [README.md](README.md#macos-foreground-sampler-alternative)。

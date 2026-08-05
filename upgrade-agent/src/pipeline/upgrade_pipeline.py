"""
L3 代码升级流水线（设计文档 6.3，分阶段处理，不是有红就滚）
代码在 Git 上，分两阶段，失败处理完全不同：

阶段 A（流水线，未上线）：
  worktree → patch → reviewer → test → build
  失败：回 patch 修订，不动线上；3轮失败→改进点回 pending 下次再试

阶段 B（灰度，已上线）：
  灰度5% → 观察(紧急×2窗口) → 50% → 观察 → 100%
  退化且观察窗口内未恢复才回滚；瞬时抖动自恢复的不回滚

紧急清单（emergency）：观察窗口加倍 ×2=20min，仍走完整 CI 不可跳过
"""
import time


class L3Pipeline:
    def __init__(self, tools):
        self.tools = tools

    def run(self, improvement: dict, is_emergency: bool = False) -> dict:
        """
        执行 L3 流水线
        :param improvement: 改进点
        :param is_emergency: 紧急清单（观察窗口加倍）
        :return: {success, release_id, rolled_back}
        """
        imp_id = improvement.get("id", "")
        observe_window = 600 * (2 if is_emergency else 1)  # 紧急×2 = 1200s

        # ========== 阶段 A：流水线（未上线，失败不动线上）==========
        # A1. 开 worktree
        wt = self.tools.call("worktree_manager", {"improvement_id": imp_id})
        worktree = wt.get("worktree_path")

        # A2. RAG 检索修复案例（failure_case 权重×1.5，防重蹈覆辙）
        rag_ctx = self.tools.call("rag_search", {
            "query": improvement.get("problem_desc", ""), "domain": "seckill"})

        # A3-A5. patch → review → test，最多3轮修订
        for attempt in range(3):
            patch = self.tools.call("patch_generator", {
                "improvement": improvement, "worktree": worktree, "rag_context": rag_ctx})
            if not patch.get("ok"):
                print(f"[L3] patch 第{attempt+1}轮失败")
                continue

            review = self.tools.call("code_reviewer", {"patch_diff": patch.get("patch_diff")})
            if review.get("verdict") != "pass":
                print(f"[L3] review 第{attempt+1}轮 reject: {review.get('comments')}")
                continue

            test = self.tools.call("test_runner", {"worktree": worktree})
            if test.get("passed"):
                break
            print(f"[L3] test 第{attempt+1}轮失败: {test.get('failed_cases')}")
        else:
            # 3轮全失败 → 改进点回 pending，下次再试（不动线上）
            print(f"[L3] {imp_id} 3轮失败，回 pending 下次再试")
            return {"success": False, "reason": "pipeline_3rounds_failed"}

        # A6. 打镜像
        build = self.tools.call("build_trigger", {"improvement_id": imp_id})
        if not build.get("ok"):
            return {"success": False, "reason": "build_failed"}

        # ========== 阶段 B：灰度（已上线，退化才回滚）==========
        # 紧急清单：人工 approve 跳过（emergency 不可跳过 CI，但可跳过 approve）
        if not is_emergency:
            # TODO: 初期 L3 红线——人工 approve（Admin 控制台确认）
            print(f"[L3] {imp_id} 等待人工 approve...")
            # pass  # 骨架跳过等待

        # B1. 灰度 5%
        self.tools.call("canary_controller", {"pct": 5})
        if not self._observe(observe_window, "5%"):
            return self._do_rollback(improvement, "灰度5%退化")

        # B2. 灰度 50%
        self.tools.call("canary_controller", {"pct": 50})
        if not self._observe(observe_window, "50%"):
            return self._do_rollback(improvement, "灰度50%退化")

        # B3. 全量 100%
        self.tools.call("canary_controller", {"pct": 100})
        if not self._observe(observe_window, "100%"):
            return self._do_rollback(improvement, "全量退化")

        # 成功 → 写经验库
        self.tools.call("experience_writer", {
            "type": "fix_case", "content": improvement.get("suggestion", ""),
            "domain": "seckill", "outcome": "success", "tags": ["L3"]})
        return {"success": True, "rolled_back": False}

    def _observe(self, window_sec: int, stage: str) -> bool:
        """灰度观察窗口：检查健康度是否达标
        瞬时抖动自恢复的不回滚（避免 MQ 抖动/GC 导致误回滚）"""
        # TODO: 等待 window_sec，期间拉健康度指标
        # 骨架：简化为立即返回健康
        print(f"[L3观察] {stage} 窗口={window_sec}s（骨架跳过等待）")
        return True

    def _do_rollback(self, improvement: dict, reason: str) -> dict:
        """触发回滚（局部/整体判断在 rollback.py）"""
        print(f"[L3回滚] {improvement.get('id')} 原因: {reason}")
        self.tools.call("rollback_executor", {
            "release_id": improvement.get("id", ""),
            "reason": reason, "scope": "partial"})
        # 写失败案例经验（反哺基线，防重蹈覆辙）
        self.tools.call("experience_writer", {
            "type": "failure_case", "content": f"{improvement.get('problem_desc')} | {reason}",
            "domain": "seckill", "outcome": "failure", "tags": ["L3", "rolled_back"]})
        return {"success": False, "rolled_back": True, "reason": reason}

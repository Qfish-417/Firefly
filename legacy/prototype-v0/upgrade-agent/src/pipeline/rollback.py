"""
回滚策略（设计文档 6.5，不一刀切）
三档回滚：
- 局部回滚：单个改进点退化，只回滚它
- 整体回滚：改了共享依赖（DTO/公共类）污染多服务，回滚整个批次
- 不回滚：观察窗口内自恢复的抖动（MQ抖动/GC）

回滚动作：git revert + 重建上一 tag + 重新部署 + 发回滚公告
"""
import os


class RollbackStrategy:
    def __init__(self):
        self.repos_dir = os.getenv("REPOS_DIR", "/data/repos")

    def execute(self, release_id: str, scope: str, reason: str) -> dict:
        """
        执行回滚
        :param release_id: 发布单 id（或改进点 id）
        :param scope: partial(局部) / overall(整体)
        :param reason: 回滚原因
        """
        print(f"[回滚] release={release_id} scope={scope} reason={reason}")

        if scope == "overall":
            return self._overall_rollback(release_id, reason)
        else:
            return self._partial_rollback(release_id, reason)

    def _partial_rollback(self, release_id: str, reason: str) -> dict:
        """局部回滚：只回滚单个改进点
        git revert {patch_commit} + 重建上一 tag + 重新部署该服务"""
        # TODO: git revert 对应 commit
        # TODO: 重建上一稳定 tag 镜像
        # TODO: 重新部署该服务
        # TODO: 改进点 status=rolled_back，回 pending 下次再试
        previous_tag = self._get_previous_tag(release_id)
        print(f"[局部回滚] 回滚到 {previous_tag}")
        return {"rolled_back": True, "previous_tag": previous_tag, "scope": "partial"}

    def _overall_rollback(self, batch_id: str, reason: str) -> dict:
        """整体回滚：回滚整个批次
        场景：改了共享依赖（DTO/公共类）污染多服务
        git revert 整个批次的所有 commit + 重建批次前 tag + 全部服务重新部署"""
        # TODO: 批次所有改进点的 commit 逐个 revert
        # TODO: 重建批次前的稳定 tag
        # TODO: 所有受影响服务重新部署
        # TODO: upgrade_plan status=rolled_back
        previous_tag = self._get_batch_previous_tag(batch_id)
        print(f"[整体回滚] 批次回滚到 {previous_tag}（共享依赖污染）")
        return {"rolled_back": True, "previous_tag": previous_tag, "scope": "overall"}

    def _get_previous_tag(self, release_id: str) -> str:
        """查上一稳定 tag（骨架）"""
        # TODO: 从 release 表查 history，找上一个 status=100 的 git_tag
        return "v0.0.9-stable"

    def _get_batch_previous_tag(self, batch_id: str) -> str:
        """查批次前的稳定 tag（骨架）"""
        return "v0.0.8-stable"

    def should_rollback(self, degradation_type: str, recovered: bool) -> bool:
        """判断是否该回滚（抖动自恢复的不回滚）"""
        if recovered:
            # 观察窗口内自恢复的抖动（MQ抖动/GC）→ 不回滚
            return False
        # 持续退化 → 回滚
        return True

"""
升级 Agent 工具注册中心（12 个工具，MCP 化）
设计原则（乐享 s02/s19）：工具 = handler + JSON schema，注册 dispatch map
慢操作（patch/build/灰度）走异步，不阻塞循环

工具清单：
1. l1_soft_upgrade      L1 软升级（改 Nacos 配置热更，收益90%）
2. l2_strategy_upgrade  L2 策略升级（改 DSL 规则 + 影子验证）
3. worktree_manager     开独立 worktree（自进化安全关键，s18）
4. patch_generator      生成补丁（LLM + AST 改写）
5. code_reviewer        代码审查（reviewer_subagent）
6. test_runner          测试验证（worktree 里跑）
7. build_trigger        打镜像 docker build
8. canary_controller    灰度控制 5%→50%→100%
9. rollback_executor    回滚执行（局部/整体）
10. announce            业务公告（每次升级必发）
11. experience_writer   经验记录
12. rag_search          RAG 检索修复案例（failure_case 权重×1.5）
"""
import os
import uuid
import httpx
import psycopg2
from typing import Callable, Dict


class UpgradeToolRegistry:
    def __init__(self):
        self.dispatch: Dict[str, Callable] = {}
        self._register_all()

    def _register_all(self):
        self.dispatch["l1_soft_upgrade"] = self.l1_soft_upgrade
        self.dispatch["l2_strategy_upgrade"] = self.l2_strategy_upgrade
        self.dispatch["worktree_manager"] = self.worktree_manager
        self.dispatch["patch_generator"] = self.patch_generator
        self.dispatch["code_reviewer"] = self.code_reviewer
        self.dispatch["test_runner"] = self.test_runner
        self.dispatch["build_trigger"] = self.build_trigger
        self.dispatch["canary_controller"] = self.canary_controller
        self.dispatch["rollback_executor"] = self.rollback_executor
        self.dispatch["announce"] = self.announce
        self.dispatch["experience_writer"] = self.experience_writer
        self.dispatch["rag_search"] = self.rag_search

    def call(self, tool_name: str, input_data: Dict) -> Dict:
        handler = self.dispatch.get(tool_name)
        if not handler:
            raise ValueError(f"未知工具: {tool_name}")
        return handler(input_data)

    # ============ 工具 handler ============

    def l1_soft_upgrade(self, input_data: Dict) -> Dict:
        """L1 软升级：改 Prompt/检索参数/路由策略，存 Nacos 热更，一键回滚"""
        # TODO: 据 improvement.suggestion 改 Nacos firefly-main-prompt.yml / firefly-rag-params.yml
        # TODO: Nacos 热更生效，通知侦察复评
        # 收益占 90%，零风险（不碰代码）
        imp = input_data.get("improvement", {})
        print(f"[L1软升级] 改 Nacos 配置: {imp.get('suggestion')}")
        return {"ok": True, "level": "L1", "config_changed": "firefly-main-prompt.yml"}

    def l2_strategy_upgrade(self, input_data: Dict) -> Dict:
        """L2 策略升级：改 DSL 规则（审查/测试/限流阈值）+ 影子流量验证"""
        # TODO: 改规则 DSL → 影子流量验证（只跑不生效）→ 复评达标放量
        # TODO: 初期需管理员 approve
        imp = input_data.get("improvement", {})
        print(f"[L2策略升级] 改规则 DSL: {imp.get('suggestion')}")
        return {"ok": True, "level": "L2", "rule_changed": "review_rules.dsl"}

    def worktree_manager(self, input_data: Dict) -> Dict:
        """开独立 worktree（源自乐享 s18，自进化安全关键）
        git worktree add ../firefly-work-{imp_id} -b fix/{imp_id}
        防多个改动互相覆盖"""
        imp_id = input_data.get("improvement_id", uuid.uuid4().hex[:8])
        # TODO: git worktree add（用 GitPython）
        path = f"/data/repos/firefly-work-{imp_id}"
        print(f"[Worktree] 开独立 worktree: {path}")
        return {"worktree_path": path, "branch": f"fix/{imp_id}"}

    def patch_generator(self, input_data: Dict) -> Dict:
        """生成补丁（派发 patch_subagent task，LLM + AST 改写）
        检索修复案例 + review 规则 + 失败案例（failure_case 权重×1.5）"""
        # TODO: 派发 patch_subagent，输入 {improvement, target_files, worktree, rag_context}
        # TODO: LLM + tree-sitter AST 改写 → patch_diff + files_changed
        # TODO: 失败重试2次 → 标 needs_human
        return {"patch_diff": "", "files_changed": [], "ok": True}

    def code_reviewer(self, input_data: Dict) -> Dict:
        """代码审查（派发 reviewer_subagent task）
        verdict(pass/reject) + comments，reject→回 patch 修订（最多3轮）"""
        # TODO: reviewer_subagent 输入 {patch_diff, review_rules}
        return {"verdict": "pass", "comments": []}

    def test_runner(self, input_data: Dict) -> Dict:
        """测试验证（在 worktree 跑 mvn test，验证补丁没破坏）
        失败→回 patch 修（3轮失败放弃）"""
        # TODO: 在 worktree 跑 mvn test，解析 JUnit XML
        return {"passed": True, "coverage": 0.85, "failed_cases": []}

    def build_trigger(self, input_data: Dict) -> Dict:
        """打镜像 docker build -t firefly-{service}:{imp_id}"""
        # TODO: docker build，失败→分析日志→回 patch
        imp_id = input_data.get("improvement_id", "latest")
        image = f"firefly-main-agent:patch-{imp_id}"
        print(f"[Build] docker build -t {image}")
        return {"image": image, "ok": True}

    def canary_controller(self, input_data: Dict) -> Dict:
        """灰度控制：5% → 观察 → 50% → 观察 → 100%
        紧急清单观察窗口加倍（×2=20min）"""
        # TODO: 调 Compose/K8s 滚动更新
        pct = input_data.get("pct", 5)
        return {"pct": pct, "healthy": True}

    def rollback_executor(self, input_data: Dict) -> Dict:
        """回滚执行（局部/整体，源自乐享 s18）
        局部：单个改进点退化，只回滚它
        整体：改了共享依赖污染多服务，回滚整个批次"""
        # TODO: git revert + 重建上一 tag + 重新部署
        from src.pipeline.rollback import RollbackStrategy
        return RollbackStrategy().execute(
            input_data.get("release_id", ""),
            input_data.get("scope", "partial"),
            input_data.get("reason", ""))

    def announce(self, input_data: Dict) -> Dict:
        """业务公告（每次升级必发：开始/成功/回滚）
        Admin 站内信 + 首页横幅，含影响接口+用户建议"""
        conn = self._pg(); cur = conn.cursor()
        ann_id = f"ann-{uuid.uuid4().hex[:12]}"
        cur.execute(
            "INSERT INTO announcement(id,plan_id,level,title,content,affected_apis,status) "
            "VALUES(%s,%s,%s,%s,%s,%s,'active')",
            (ann_id, input_data.get("plan_id"), input_data.get("level", "info"),
             input_data.get("title", ""), input_data.get("content", ""),
             str(input_data.get("affected_apis", []))))
        conn.commit(); cur.close(); conn.close()
        print(f"[公告] {input_data.get('title')}")
        return {"ann_id": ann_id, "published": True}

    def experience_writer(self, input_data: Dict) -> Dict:
        """经验记录（成功案例/失败案例反哺基线）"""
        # TODO: 写 Milvus + Postgres，失败案例 failure_case 权重×1.5
        conn = self._pg(); cur = conn.cursor()
        exp_id = f"exp-{uuid.uuid4().hex[:12]}"
        cur.execute(
            "INSERT INTO experience(id,type,content,domain,tags,outcome) VALUES(%s,%s,%s,%s,%s,%s)",
            (exp_id, input_data.get("type", "fix_case"),
             input_data.get("content", ""), input_data.get("domain", "seckill"),
             str(input_data.get("tags", [])), input_data.get("outcome", "success")))
        conn.commit(); cur.close(); conn.close()
        return {"ok": True, "id": exp_id}

    def rag_search(self, input_data: Dict) -> Dict:
        """RAG 检索修复案例 + review 规则 + 失败案例（failure_case 权重×1.5）"""
        from src.rag.rag_search import RagSearcher
        return RagSearcher().search(
            query=input_data.get("query", ""),
            agent_name="upgrade",
            types=input_data.get("types", ["fix_case", "review_rule", "failure_case"]),
            domain=input_data.get("domain", ""))

    @staticmethod
    def _pg():
        return psycopg2.connect(
            host=os.getenv("POSTGRES_HOST", "localhost"),
            dbname="firefly", user="firefly", password="firefly123")

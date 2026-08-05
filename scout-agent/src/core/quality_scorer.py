"""
侦察 Agent 评估指标体系（功能 4 打分维度，闭环咽喉，先建）
源自设计文档 5.2

综合分 = Σ(维度分 × 权重)
- 低于基线 5% 触发 P1 改进点
- 低于基线 10% 触发 P0 改进点
"""
from typing import Dict, Any


class QualityScorer:
    """质量打分器（派发 scorer_subagent teammate，跨轮对比基线趋势）"""

    # 指标维度定义：维度 → (指标名, 基线, 权重, 方向)
    # 方向: ge=越大越好(需≥基线), le=越小越好(需≤基线)
    DIMENSIONS = {
        "availability":      ("interface_success_rate", 0.999, 0.30, "ge"),
        "seckill_p99":       ("seckill_p99_ms",        200,   0.20, "le"),
        "order_p99":         ("order_p99_ms",          500,   0.10, "le"),
        "oversell_rate":     ("oversell_rate",         0,     0.20, "le"),
        "payment_idempotent":("payment_idempotent_rate", 1.0, 0.10, "ge"),
        "test_coverage":     ("test_coverage",         0.80,  0.05, "ge"),
        "test_pass_rate":    ("test_pass_rate",        1.0,   0.05, "ge"),
    }

    def score(self, metrics: Dict[str, Any]) -> Dict[str, Any]:
        """
        多维打分，对比基线算趋势
        :param metrics: metric_scraper 采集的指标
        :return: {overall, dimensions, trend}
        """
        dimensions = {}
        overall = 0.0
        for dim, (metric_name, baseline, weight, direction) in self.DIMENSIONS.items():
            actual = metrics.get(metric_name, baseline)
            # 计算维度分：达标=1.0，未达标按比例
            if direction == "ge":
                dim_score = min(actual / baseline, 1.0) if baseline > 0 else 1.0
            else:
                dim_score = min(baseline / actual, 1.0) if actual > 0 else 1.0
            dimensions[dim] = round(dim_score, 4)
            overall += dim_score * weight

        overall = round(overall, 4)
        trend = self._calc_trend(overall)
        return {"overall": overall, "dimensions": dimensions, "trend": trend}

    def _calc_trend(self, current_score: float) -> str:
        """对比上次基线算趋势（up/down/flat）"""
        # TODO: 从 evaluation_baseline 表读上次分数对比
        # 简化：>0.95 up, <0.85 down, else flat
        if current_score >= 0.95:
            return "up"
        elif current_score < 0.85:
            return "down"
        return "flat"

    def determine_priority(self, score: float, baseline: float = 0.95) -> str:
        """据分数偏离基线程度判定改进点优先级"""
        drop = baseline - score
        if drop >= 0.10:
            return "P0"  # 超10% → P0（超卖/支付故障）
        elif drop >= 0.05:
            return "P1"  # 超5% → P1（p99超标）
        return "P2"  # 优化项

    def determine_level(self, problem_type: str) -> str:
        """据问题类型判定升级档位 L1/L2/L3"""
        # L1 软升级: Prompt/检索参数/路由
        # L2 策略升级: DSL 规则（审查/测试/限流阈值）
        # L3 代码升级: 改源码（如库存扣减逻辑）
        if problem_type in ("prompt", "rag_param", "routing"):
            return "L1"
        elif problem_type in ("review_rule", "test_strategy", "rate_limit"):
            return "L2"
        else:
            return "L3"

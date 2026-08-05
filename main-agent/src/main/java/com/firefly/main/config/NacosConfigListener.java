package com.firefly.main.config;

import com.firefly.main.statemachine.SeckillStockStrategy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.cloud.context.config.annotation.RefreshScope;
import org.springframework.context.annotation.Configuration;

import javax.annotation.PostConstruct;

/**
 * Nacos 配置热更监听（L1 软升级的核心机制）
 * 监听以下 dataId 变更，热更生效无需重启：
 * - firefly-main-prompt.yml    主力 code_generator 的 Prompt
 * - firefly-sentinel-rules.json  限流规则
 * - firefly-canary-strategy.yml  灰度策略
 * - firefly-rag-params.yml       检索 top_k / rerank 阈值 / BM25 权重
 *
 * @RefreshScope 注解的 Bean 会在配置变更时自动重建
 * L1 软升级（90% 收益）就是改这些配置，不碰代码
 */
@Configuration
@RefreshScope
public class NacosConfigListener {

    @Autowired
    private SeckillStockStrategy stockStrategy;

    /** 当前秒杀库存档位（升级 Agent 通过 Nacos 热更切换 L1→L2→L3） */
    @org.springframework.beans.factory.annotation.Value("${firefly.seckill.stock-level:L1}")
    private String stockLevel;

    @PostConstruct
    public void applyConfig() {
        // 应用热更的库存档位
        stockStrategy.setStockLevel(stockLevel);
        System.out.println("[Nacos热更] 秒杀库存档位 = " + stockLevel);
    }
}

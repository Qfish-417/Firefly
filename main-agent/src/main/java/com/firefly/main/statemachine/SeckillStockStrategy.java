package com.firefly.main.statemachine;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.concurrent.TimeUnit;

/**
 * 秒杀库存扣减策略（三档，升级 Agent 决定升哪档）
 *
 * | 档 | 实现                         | 风险       | 性能   | 由谁生成     |
 * | L1 | DB 直接 UPDATE stock-1 WHERE stock>0 | 超卖(高并发竞争) | 低  | 主力初始生成 |
 * | L2 | Redis DECR 原子预扣 + MQ 异步落库    | 防超卖+削峰    | 高  | 升级优化     |
 * | L3 | L2 + 内存标记(预扣完直接拒绝)        | 防超卖+极致性能| 极高| 升级终极优化 |
 *
 * 主力生成时默认 L1，升级 Agent 据侦察的"超卖率/p99"指标决定升 L2/L3。
 * 三档策略通过 stockLevel 配置切换（Nacos 热更），无需改代码。
 */
@Component
public class SeckillStockStrategy {

    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private StringRedisTemplate redis;

    /** 内存标记：秒杀活动库存是否已抢空（L3 用） */
    private final java.util.concurrent.ConcurrentHashMap<String, Boolean> soldOutMark =
            new java.util.concurrent.ConcurrentHashMap<>();

    /** 当前库存档位，默认 L1（升级 Agent 通过 Nacos 热更切换） */
    private volatile String stockLevel = "L1";

    public void setStockLevel(String level) {
        this.stockLevel = level;
        // 切档时清空内存标记
        soldOutMark.clear();
    }

    /**
     * 扣减库存
     * @param activityId 秒杀活动 id
     * @return true=扣减成功(可下单), false=库存不足
     */
    public boolean deduct(String activityId) {
        switch (stockLevel) {
            case "L1": return deductByDb(activityId);
            case "L2": return deductByRedis(activityId);
            case "L3": return deductByRedisWithMark(activityId);
            default:   return deductByDb(activityId);
        }
    }

    /**
     * L1: DB 直接扣（主力初始生成）
     * UPDATE stock = stock - 1 WHERE stock > 0
     * 风险：高并发下行竞争，可能超卖
     */
    private boolean deductByDb(String activityId) {
        int affected = jdbc.update(
                "UPDATE seckill_activity SET stock = stock - 1 WHERE id = ? AND stock > 0",
                activityId);
        return affected > 0;
    }

    /**
     * L2: Redis DECR 原子预扣 + MQ 异步落库（升级优化）
     * 防超卖 + 削峰，Redis 原子操作无竞争
     * TODO: 预扣成功后发 MQ 异步落库（rocketmq producer）
     */
    private boolean deductByRedis(String activityId) {
        String key = "seckill:stock:" + activityId;
        Long remain = redis.opsForValue().decrement(key);
        if (remain == null) {
            // key 不存在，初始化（首次访问从 DB 加载）
            Integer dbStock = jdbc.queryForObject(
                    "SELECT stock FROM seckill_activity WHERE id = ?", Integer.class, activityId);
            if (dbStock == null || dbStock <= 0) return false;
            redis.opsForValue().set(key, String.valueOf(dbStock));
            remain = redis.opsForValue().decrement(key);
        }
        if (remain != null && remain < 0) {
            // 库存不足，回滚 DECR
            redis.opsForValue().increment(key);
            return false;
        }
        // TODO: 发 MQ 异步落库扣减 DB
        return true;
    }

    /**
     * L3: L2 + 内存标记（升级终极优化）
     * 预扣完后直接内存拒绝，减少 Redis 访问，极致性能
     */
    private boolean deductByRedisWithMark(String activityId) {
        // 内存标记已售空，直接拒绝
        if (soldOutMark.getOrDefault(activityId, false)) {
            return false;
        }
        String key = "seckill:stock:" + activityId;
        Long remain = redis.opsForValue().decrement(key);
        if (remain == null) return false;
        if (remain < 0) {
            redis.opsForValue().increment(key);
            // 标记售空，后续请求直接内存拒绝
            soldOutMark.put(activityId, true);
            return false;
        }
        // TODO: 发 MQ 异步落库
        return true;
    }

    /** 初始化某活动的 Redis 库存（活动开始时调用） */
    public void initRedisStock(String activityId, int stock) {
        redis.opsForValue().set("seckill:stock:" + activityId, String.valueOf(stock));
        redis.expire("seckill:stock:" + activityId, 2, TimeUnit.HOURS);
        soldOutMark.remove(activityId);
    }
}

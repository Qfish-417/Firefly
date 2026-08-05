package com.firefly.main.service;

import com.firefly.main.model.Order;
import com.firefly.main.model.SeckillActivity;
import com.firefly.main.statemachine.SeckillStockStrategy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.BeanPropertyRowMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * 秒杀服务（功能 7 对外服务的秒杀部分）
 * 库存扣减走 SeckillStockStrategy（三档可切换）
 * 扣减成功 → 创建订单（pending，等待支付）
 */
@Service
public class SeckillService {

    @Autowired
    private SeckillStockStrategy stockStrategy;
    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private OrderService orderService;

    /** 秒杀下单 */
    public Order seckillOrder(String userId, String activityId) {
        // 1. 库存扣减（三档策略，升级 Agent 决定档位）
        boolean ok = stockStrategy.deduct(activityId);
        if (!ok) {
            throw new IllegalStateException("秒杀失败：库存不足或活动已结束");
        }
        // 2. 查活动信息创建订单
        SeckillActivity activity = findActivity(activityId);
        if (activity == null) {
            throw new IllegalArgumentException("秒杀活动不存在: " + activityId);
        }
        // 3. 创建 pending 订单（待支付）
        return orderService.createOrder(userId, activity.getCourseId(), activityId, activity.getSeckillPrice());
    }

    public SeckillActivity findActivity(String id) {
        List<SeckillActivity> list = jdbc.query("SELECT * FROM seckill_activity WHERE id=?",
                new BeanPropertyRowMapper<>(SeckillActivity.class), id);
        return list.isEmpty() ? null : list.get(0);
    }
}

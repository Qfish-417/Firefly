package com.firefly.main.statemachine;

import java.util.EnumMap;
import java.util.Map;
import java.util.Set;

/**
 * 订单状态机（功能 7 核心，编码必须实现）
 *
 * 待支付(pending) --支付成功--> 已支付(paid) --发货/开通--> 已完成(done)
 *     |                              |
 *     |超时30min                     |申请退款
 *     ↓                              ↓
 * 已取消(canceled)              退款中(refunding) --退款成功--> 已退款(refunded)
 *
 * 关键约束：
 * - 状态转换全部走本类 transition()，禁止 Service 直接 update 状态字段
 * - 支付回调必须幂等（基于 out_trade_no 去重）
 * - 退款需校验订单状态 ∈ {paid, done}
 */
public class OrderStateMachine {

    public enum Status {
        PENDING, PAID, DONE, CANCELED, REFUNDING, REFUNDED
    }

    public enum Event {
        PAY_SUCCESS,      // 支付成功
        SHIP,             // 发货/开通课程
        TIMEOUT,          // 超时30min未支付
        REQUEST_REFUND,   // 申请退款
        REFUND_SUCCESS    // 退款成功
    }

    /** 合法状态转换表：当前状态 + 事件 → 目标状态 */
    private static final Map<Status, Map<Event, Status>> TRANSITIONS = new EnumMap<>(Status.class);

    static {
        // pending: 支付成功→paid, 超时→canceled
        TRANSITIONS.put(Status.PENDING, Map.of(
                Event.PAY_SUCCESS, Status.PAID,
                Event.TIMEOUT, Status.CANCELED
        ));
        // paid: 发货→done, 申请退款→refunding
        TRANSITIONS.put(Status.PAID, Map.of(
                Event.SHIP, Status.DONE,
                Event.REQUEST_REFUND, Status.REFUNDING
        ));
        // done: 申请退款→refunding（已完成也可退）
        TRANSITIONS.put(Status.DONE, Map.of(
                Event.REQUEST_REFUND, Status.REFUNDING
        ));
        // refunding: 退款成功→refunded
        TRANSITIONS.put(Status.REFUNDING, Map.of(
                Event.REFUND_SUCCESS, Status.REFUNDED
        ));
    }

    /**
     * 执行状态转换
     * @param current 当前状态
     * @param event   触发事件
     * @return 新状态
     * @throws IllegalStateException 非法转换（编码时应阻断，回滚事务）
     */
    public static Status transition(Status current, Event event) {
        Map<Event, Status> eventMap = TRANSITIONS.get(current);
        if (eventMap == null || !eventMap.containsKey(event)) {
            throw new IllegalStateException(
                    String.format("非法订单状态转换: %s + %s", current, event));
        }
        return eventMap.get(event);
    }

    /** 校验某状态是否允许退款（退款入口前置校验） */
    public static boolean canRefund(Status current) {
        return current == Status.PAID || current == Status.DONE;
    }

    /** 终态（不可再转换） */
    public static final Set<Status> TERMINAL = Set.of(Status.CANCELED, Status.REFUNDED);
}

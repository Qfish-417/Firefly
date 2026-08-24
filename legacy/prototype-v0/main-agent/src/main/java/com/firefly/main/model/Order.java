package com.firefly.main.model;

import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 订单实体（对应 order 表）
 * 状态转换走 OrderStateMachine，禁止直接 setStatus 跳过状态机
 */
@Data
public class Order {
    private String id;
    private String userId;
    private String courseId;
    private String seckillId;
    private BigDecimal amount;
    /** pending/paid/done/canceled/refunding/refunded */
    private String status;
    /** 支付幂等：同一 out_trade_no 重复回调直接返回成功 */
    private String outTradeNo;
    private LocalDateTime createdAt;
    private LocalDateTime paidAt;
    /** 超时取消时间点（30min） */
    private LocalDateTime timeoutAt;
}

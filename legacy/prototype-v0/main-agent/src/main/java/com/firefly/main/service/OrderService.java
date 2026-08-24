package com.firefly.main.service;

import com.firefly.main.model.Order;
import com.firefly.main.statemachine.OrderStateMachine;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.BeanPropertyRowMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

/**
 * 订单服务（功能 7 对外服务的订单部分）
 * 状态转换全部走 OrderStateMachine，支付回调幂等，超时30min自动取消
 */
@Service
public class OrderService {

    @Autowired
    private JdbcTemplate jdbc;

    /** 创建订单（下单入口，初始 pending） */
    public Order createOrder(String userId, String courseId, String seckillId,
                             java.math.BigDecimal amount) {
        Order order = new Order();
        order.setId("ord-" + UUID.randomUUID().toString().substring(0, 12));
        order.setUserId(userId);
        order.setCourseId(courseId);
        order.setSeckillId(seckillId);
        order.setAmount(amount);
        order.setStatus(OrderStateMachine.Status.PENDING.name().toLowerCase());
        order.setOutTradeNo("pay-" + UUID.randomUUID().toString().substring(0, 12));
        order.setCreatedAt(LocalDateTime.now());
        order.setTimeoutAt(LocalDateTime.now().plusMinutes(30));  // 30min 超时

        jdbc.update("INSERT INTO \"order\"(id,user_id,course_id,seckill_id,amount,status,out_trade_no,created_at,timeout_at) " +
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                order.getId(), order.getUserId(), order.getCourseId(), order.getSeckillId(),
                order.getAmount(), order.getStatus(), order.getOutTradeNo(),
                order.getCreatedAt(), order.getTimeoutAt());
        return order;
    }

    /**
     * 支付回调（必须幂等）
     * 基于 out_trade_no 去重：已处理直接返回成功，不重复开通
     */
    public Order payCallback(String outTradeNo) {
        Order order = findByOutTradeNo(outTradeNo);
        if (order == null) {
            throw new IllegalArgumentException("无效的 out_trade_no: " + outTradeNo);
        }
        // 幂等：已是 paid/done 直接返回成功
        OrderStateMachine.Status current = OrderStateMachine.Status.valueOf(order.getStatus().toUpperCase());
        if (current == OrderStateMachine.Status.PAID || current == OrderStateMachine.Status.DONE) {
            return order;
        }
        // 走状态机：pending + PAY_SUCCESS → paid
        String newStatus = OrderStateMachine.transition(current, OrderStateMachine.Event.PAY_SUCCESS)
                .name().toLowerCase();
        jdbc.update("UPDATE \"order\" SET status=?, paid_at=? WHERE id=?",
                newStatus, LocalDateTime.now(), order.getId());
        order.setStatus(newStatus);
        return order;
    }

    /** 申请退款（校验状态 ∈ {paid, done}） */
    public Order requestRefund(String orderId) {
        Order order = findById(orderId);
        if (order == null) throw new IllegalArgumentException("订单不存在: " + orderId);
        OrderStateMachine.Status current = OrderStateMachine.Status.valueOf(order.getStatus().toUpperCase());
        if (!OrderStateMachine.canRefund(current)) {
            throw new IllegalStateException("当前状态不允许退款: " + current);
        }
        String newStatus = OrderStateMachine.transition(current, OrderStateMachine.Event.REQUEST_REFUND)
                .name().toLowerCase();
        jdbc.update("UPDATE \"order\" SET status=? WHERE id=?", newStatus, orderId);
        order.setStatus(newStatus);
        return order;
    }

    /** 定时任务：扫超时未支付订单自动取消（每分钟） */
    @Scheduled(fixedRate = 60000)
    public void cancelTimeoutOrders() {
        List<Order> timeouts = jdbc.query(
                "SELECT * FROM \"order\" WHERE status='pending' AND timeout_at < NOW()",
                new BeanPropertyRowMapper<>(Order.class));
        for (Order order : timeouts) {
            String newStatus = OrderStateMachine.transition(
                    OrderStateMachine.Status.PENDING, OrderStateMachine.Event.TIMEOUT)
                    .name().toLowerCase();
            jdbc.update("UPDATE \"order\" SET status=? WHERE id=?", newStatus, order.getId());
        }
    }

    public Order findById(String id) {
        List<Order> list = jdbc.query("SELECT * FROM \"order\" WHERE id=?",
                new BeanPropertyRowMapper<>(Order.class), id);
        return list.isEmpty() ? null : list.get(0);
    }

    public Order findByOutTradeNo(String outTradeNo) {
        List<Order> list = jdbc.query("SELECT * FROM \"order\" WHERE out_trade_no=?",
                new BeanPropertyRowMapper<>(Order.class), outTradeNo);
        return list.isEmpty() ? null : list.get(0);
    }
}

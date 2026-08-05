package com.firefly.main.controller;

import com.firefly.main.model.Order;
import com.firefly.main.service.OrderService;
import com.firefly.main.service.SeckillService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 对外业务 API（功能 7，7×24 承接学员流量）
 * 秒杀/订单/支付回调/退款
 * 被 Sentinel 限流保护（按 API 重要级配 QPS）
 */
@RestController
@RequestMapping("/api")
public class BusinessController {

    @Autowired
    private SeckillService seckillService;
    @Autowired
    private OrderService orderService;

    /** 秒杀下单（限流 QPS 10000，按 NFR 配） */
    @PostMapping("/seckill/{activityId}")
    public Map<String, Object> seckill(@PathVariable String activityId,
                                       @RequestParam String userId) {
        Order order = seckillService.seckillOrder(userId, activityId);
        return Map.of(
                "code", 0,
                "orderId", order.getId(),
                "outTradeNo", order.getOutTradeNo(),
                "amount", order.getAmount(),
                "status", order.getStatus()
        );
    }

    /**
     * 支付回调（必须幂等，基于 out_trade_no 去重）
     * 重复回调直接返回成功，不重复开通
     */
    @PostMapping("/order/pay/callback")
    public Map<String, Object> payCallback(@RequestParam String outTradeNo) {
        Order order = orderService.payCallback(outTradeNo);
        return Map.of("code", 0, "orderId", order.getId(), "status", order.getStatus());
    }

    /** 申请退款（校验订单状态 ∈ {paid, done}） */
    @PostMapping("/order/{id}/refund")
    public Map<String, Object> refund(@PathVariable String id) {
        Order order = orderService.requestRefund(id);
        return Map.of("code", 0, "orderId", order.getId(), "status", order.getStatus());
    }

    /** 查订单 */
    @GetMapping("/order/{id}")
    public Map<String, Object> getOrder(@PathVariable String id) {
        Order order = orderService.findById(id);
        if (order == null) return Map.of("code", 404, "msg", "订单不存在");
        return Map.of("code", 0, "data", order);
    }
}

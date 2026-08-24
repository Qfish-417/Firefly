package com.firefly.main.model;

import lombok.Data;
import java.time.LocalDateTime;

/** 接口需求单（业务方提交 → 主力解析成 OpenAPI → 生成代码） */
@Data
public class InterfaceRequirement {
    private String id;
    /** course/seckill/order/pay/user */
    private String businessDomain;
    private String requirementText;
    /** JSON: 字段表 */
    private String fieldTable;
    /** JSON: {qps, latency_p99, consistency} */
    private String sla;
    /** parsed/generating/testing/deploying/online/failed */
    private String status;
    /** JSON: OpenAPI 3.0 规范 */
    private String openapiSpec;
    /** JSON: 非功能需求 */
    private String nfr;
    private String clarificationQuestions;
    private String createdBy;
    private LocalDateTime createdAt;
}

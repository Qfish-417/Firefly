# 多阶段构建：先编译再瘦身运行
FROM maven:3.9-eclipse-temurin-11 AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src ./src
RUN mvn package -DskipTests -B

FROM eclipse-temurin:11-jre
WORKDIR /app
COPY --from=builder /build/target/*.jar app.jar
EXPOSE 8080 9090
ENTRYPOINT ["java", "-jar", "/app/app.jar"]

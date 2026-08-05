FROM python:3.11-slim
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
COPY src ./src
EXPOSE 8082 9093
ENTRYPOINT ["python", "-m", "uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "8082"]

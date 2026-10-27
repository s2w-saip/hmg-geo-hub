FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /work/back
# PyICU: screen sorts use the same ICU collation as the browser's localeCompare.
RUN apt-get update && apt-get install -y --no-install-recommends libicu-dev pkg-config g++ \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/gold-requirements.txt
RUN pip install --no-cache-dir -r /tmp/gold-requirements.txt
COPY . /work/back/bff
CMD ["python", "-m", "uvicorn", "bff.app:app", "--host", "0.0.0.0", "--port", "8000"]

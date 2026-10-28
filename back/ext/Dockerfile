FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /work/back
COPY requirements.txt /tmp/ext-requirements.txt
RUN pip install --no-cache-dir -r /tmp/ext-requirements.txt
COPY . /work/back/ext
# Read-only external API: needs HGH_EXT_DB_URL (hmg_ext_api) and nothing else.
CMD ["python", "-m", "uvicorn", "ext.app:app", "--host", "0.0.0.0", "--port", "8000", "--log-config", "ext/logging.json"]

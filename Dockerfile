# ── Stage 1: build the React frontend ────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --frozen-lockfile

COPY frontend/ .
RUN npm run build

# ── Stage 2: Python runtime ───────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .

# Copy the compiled React app so FastAPI can serve it
COPY --from=frontend-builder /frontend/dist ./static

EXPOSE 6262

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "6262"]

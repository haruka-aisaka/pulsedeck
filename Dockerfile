FROM denoland/deno:alpine-2.3.6

WORKDIR /app
COPY deno.json ./
COPY server ./server
COPY web ./web

# 依存を事前キャッシュ（標準ライブラリのみだが起動を高速化）
RUN deno cache server/main.ts

EXPOSE 8480
CMD ["deno", "task", "start"]

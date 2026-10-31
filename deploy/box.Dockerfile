# The image every shared-teammate box runs (and the egress proxy). Only src/public goes in: no hub code, no web app.
#   sudo docker build -t hearth-box -f deploy/box.Dockerfile /opt/hearth
FROM oven/bun:1.3-alpine
WORKDIR /app
RUN echo '{"type":"module","private":true}' > package.json \
 && bun add @anthropic-ai/sdk@1.3.0 \
 && rm -rf /root/.bun/install/cache
COPY src/public ./src/public
USER 10001:10001
ENV BOX_BUNDLE=/bundle BOX_DATA=/data
ENTRYPOINT ["bun", "src/public/box.ts"]

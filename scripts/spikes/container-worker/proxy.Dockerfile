# Egress proxy for the container-worker spike: CONNECT only to the allowlist in egress-allow.txt.
FROM alpine:3.20
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY egress-allow.txt /etc/tinyproxy/allow
USER nobody
EXPOSE 8888
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]

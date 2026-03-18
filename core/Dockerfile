FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o tlive-core ./cmd/tlive-core/

FROM alpine:3.19
RUN apk add --no-cache git ca-certificates
COPY --from=builder /app/tlive-core /usr/local/bin/
EXPOSE 8080
ENTRYPOINT ["tlive-core"]
CMD ["daemon", "--port", "8080"]

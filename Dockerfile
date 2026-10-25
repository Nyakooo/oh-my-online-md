FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /online-md .

FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=build /online-md /online-md
ENV DATA_DIR=/data PORT=10777
USER 0:0
EXPOSE 10777
VOLUME ["/data"]
ENTRYPOINT ["/online-md"]

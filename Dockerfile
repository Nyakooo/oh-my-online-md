FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /online-md .

FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=build /online-md /online-md
COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/
COPY web/editor.LICENSE.txt /licenses/editor.LICENSE.txt
ENV DATA_DIR=/data PORT=10777
USER 0:0
EXPOSE 10777
VOLUME ["/data"]
ENTRYPOINT ["/online-md"]

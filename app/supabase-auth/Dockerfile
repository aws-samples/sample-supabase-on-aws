# Build stage: run natively on host (arm64), cross-compile to amd64
# This avoids QEMU emulation segfaults
FROM --platform=$BUILDPLATFORM golang:1.25.5-alpine3.23 as build
ENV GO111MODULE=on
ENV CGO_ENABLED=0
ENV GOOS=linux
ENV GOARCH=amd64
ENV GOPROXY=https://proxy.golang.org,direct

RUN apk add --no-cache make git

WORKDIR /go/src/github.com/supabase/auth

# Pulling dependencies
COPY ./Makefile ./go.* ./
RUN make deps

# Building stuff
COPY . /go/src/github.com/supabase/auth

RUN go build -ldflags "-X github.com/supabase/auth/internal/utilities.Version=vunspecified" -buildvcs=false

# Runtime stage: amd64 alpine for ECS Fargate
FROM --platform=linux/amd64 alpine:3
RUN adduser -D -u 1000 supabase

RUN apk add --no-cache ca-certificates
COPY certs/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
COPY --from=build /go/src/github.com/supabase/auth/auth /usr/local/bin/auth
COPY --from=build /go/src/github.com/supabase/auth/migrations /usr/local/etc/auth/migrations/
RUN ln -s /usr/local/bin/auth /usr/local/bin/gotrue

ENV GOTRUE_DB_MIGRATIONS_PATH /usr/local/etc/auth/migrations

USER supabase
CMD ["auth"]

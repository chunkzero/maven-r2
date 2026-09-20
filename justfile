set shell := ["bash", "-euc"]

default:
    @just --list

setup:
    mise install
    pnpm install
    go mod download

dev:
    pnpm dev

format:
    pnpm format
    gofmt -w cli internal

check:
    pnpm format:check
    pnpm lint
    pnpm typecheck
    test -z "$(gofmt -l cli internal)"
    go vet ./...

test:
    pnpm test:worker
    go test -race ./...

build:
    pnpm build
    go build -o bin/maven-r2 ./cli

contracts:
    pnpm contracts
    go generate ./internal/api

ready: check test build

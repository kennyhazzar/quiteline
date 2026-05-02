package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"highload-ws-pubsub/internal/api"
	"highload-ws-pubsub/internal/auth"
	"highload-ws-pubsub/internal/broker"
	"highload-ws-pubsub/internal/config"
	"highload-ws-pubsub/internal/files"
	"highload-ws-pubsub/internal/metrics"
	"highload-ws-pubsub/internal/ws"
	"highload-ws-pubsub/internal/zk"
)

func main() {
	cfg := config.Load()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	if err := cfg.Validate(); err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	registry := metrics.NewRegistry()
	hub := ws.NewHub(cfg, registry, logger)

	var zkStore zk.Store
	var userStore auth.UserStore
	var sessionStore auth.SessionStore
	if cfg.PostgresDSN != "" {
		pgStore, err := zk.NewPostgresStore(ctx, cfg.PostgresDSN)
		if err != nil {
			logger.Error("failed to connect to postgres", "error", err)
			os.Exit(1)
		}
		defer pgStore.Close()
		zkStore = pgStore
		pgUsers, err := auth.NewPostgresUserStore(ctx, cfg.PostgresDSN)
		if err != nil {
			logger.Error("failed to connect to postgres user store", "error", err)
			os.Exit(1)
		}
		defer pgUsers.Close()
		userStore = pgUsers
		sessionStore = pgUsers
		logger.Info("using postgres store")
	} else {
		zkStore = zk.NewMemoryStore()
		memUsers := auth.NewMemoryUserStore()
		userStore = memUsers
		sessionStore = auth.NewMemorySessionStore()
		logger.Info("using memory store")
	}
	authService := auth.NewService(cfg, userStore)
	authService.SetSessionStore(sessionStore)
	fileStore, err := files.NewS3Store(ctx, cfg)
	if err != nil {
		logger.Error("failed to create s3 file store", "error", err)
		os.Exit(1)
	}

	messageBroker, err := broker.New(ctx, cfg, logger)
	if err != nil {
		logger.Error("failed to create broker", "error", err)
		os.Exit(1)
	}
	defer messageBroker.Close()

	handler := api.New(api.Dependencies{
		Config:  cfg,
		Broker:  messageBroker,
		Hub:     hub,
		Metrics: registry,
		Logger:  logger,
		Auth:    authService,
		ZKStore: zkStore,
		Files:   fileStore,
	})

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		if err := messageBroker.Subscribe(ctx, hub.Deliver); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error("broker subscription stopped", "error", err)
			stop()
		}
	}()

	go func() {
		logger.Info("server started", "addr", cfg.HTTPAddr, "broker", cfg.Broker)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	logger.Info("server stopping")
	hub.Close()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("server shutdown failed", "error", err)
	}
}

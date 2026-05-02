package config

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddr           string
	PostgresDSN        string
	Broker             string
	RedisAddr          string
	RedisPassword      string
	RedisDB            int
	RedisChannelPrefix string
	NodeID             string
	ClientBuffer       int
	MaxMessageBytes    int64
	WriteWait          time.Duration
	PongWait           time.Duration
	PingPeriod         time.Duration
	LogLevel           slog.Level
	AuthEnabled        bool
	AuthIssuer         string
	AuthTokenTTL       time.Duration
	AuthSecret         string
	APIKeys            map[string]string
	CORSAllowedOrigins []string
	S3Endpoint         string
	S3AccessKey        string
	S3SecretKey        string
	S3Bucket           string
	S3UseSSL           bool
	MaxFileBytes       int64
	Production         bool
}

func Load() Config {
	pongWait := durationEnv("WS_PONG_WAIT", 60*time.Second)
	return Config{
		HTTPAddr:           stringEnv("HTTP_ADDR", ":8080"),
		PostgresDSN:        stringEnv("POSTGRES_DSN", ""),
		Broker:             strings.ToLower(stringEnv("BROKER", "redis")),
		RedisAddr:          stringEnv("REDIS_ADDR", "localhost:6379"),
		RedisPassword:      stringEnv("REDIS_PASSWORD", ""),
		RedisDB:            intEnv("REDIS_DB", 0),
		RedisChannelPrefix: stringEnv("REDIS_CHANNEL_PREFIX", "pubsub"),
		NodeID:             stringEnv("NODE_ID", hostname()),
		ClientBuffer:       intEnv("WS_CLIENT_BUFFER", 256),
		MaxMessageBytes:    int64(intEnv("WS_MAX_MESSAGE_BYTES", 64*1024)),
		WriteWait:          durationEnv("WS_WRITE_WAIT", 10*time.Second),
		PongWait:           pongWait,
		PingPeriod:         durationEnv("WS_PING_PERIOD", (pongWait*9)/10),
		LogLevel:           logLevelEnv("LOG_LEVEL", slog.LevelInfo),
		AuthEnabled:        boolEnv("AUTH_ENABLED", false),
		AuthIssuer:         stringEnv("AUTH_ISSUER", "highload-ws-pubsub"),
		AuthTokenTTL:       durationEnv("AUTH_TOKEN_TTL", 2*time.Hour),
		AuthSecret:         stringEnv("AUTH_SECRET", "local-dev-secret-change-me"),
		APIKeys:            apiKeysEnv("API_KEYS", "frontend:dev-secret"),
		CORSAllowedOrigins: csvEnv("CORS_ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:3001"),
		S3Endpoint:         stringEnv("S3_ENDPOINT", "localhost:9000"),
		S3AccessKey:        stringEnv("S3_ACCESS_KEY", "minioadmin"),
		S3SecretKey:        stringEnv("S3_SECRET_KEY", "minioadmin"),
		S3Bucket:           stringEnv("S3_BUCKET", "zk-messenger"),
		S3UseSSL:           boolEnv("S3_USE_SSL", false),
		MaxFileBytes:       int64(intEnv("MAX_FILE_BYTES", 100*1024*1024+4096)),
		Production:         boolEnv("PRODUCTION", false),
	}
}

func (c Config) Validate() error {
	if c.Production {
		if !c.AuthEnabled {
			return errConfig("AUTH_ENABLED must be true in production")
		}
		if c.AuthSecret == "" || c.AuthSecret == "local-dev-secret-change-me" || c.AuthSecret == "local-compose-secret-change-me" || len(c.AuthSecret) < 32 {
			return errConfig("AUTH_SECRET must be set to a strong random value of at least 32 characters")
		}
		for _, origin := range c.CORSAllowedOrigins {
			if !strings.HasPrefix(origin, "https://") {
				return errConfig("CORS_ALLOWED_ORIGINS must use https:// origins in production")
			}
		}
		if c.PostgresDSN == "" {
			return errConfig("POSTGRES_DSN is required in production")
		}
	}
	return nil
}

type errConfig string

func (e errConfig) Error() string {
	return string(e)
}

func stringEnv(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func intEnv(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func boolEnv(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func csvEnv(key, fallback string) []string {
	raw := stringEnv(key, fallback)
	values := strings.Split(raw, ",")
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func apiKeysEnv(key, fallback string) map[string]string {
	raw := stringEnv(key, fallback)
	result := make(map[string]string)
	for _, pair := range strings.Split(raw, ",") {
		clientID, secret, ok := strings.Cut(strings.TrimSpace(pair), ":")
		if !ok {
			continue
		}
		clientID = strings.TrimSpace(clientID)
		secret = strings.TrimSpace(secret)
		if clientID != "" && secret != "" {
			result[clientID] = secret
		}
	}
	return result
}

func logLevelEnv(key string, fallback slog.Level) slog.Level {
	switch strings.ToLower(stringEnv(key, "")) {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	case "info":
		return slog.LevelInfo
	default:
		return fallback
	}
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil || strings.TrimSpace(name) == "" {
		return "node-local"
	}
	return name
}

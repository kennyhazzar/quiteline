package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	addr := flag.String("addr", "localhost:8080", "server address")
	topic := flag.String("topic", "load", "topic name")
	token := flag.String("token", "", "optional bearer token")
	connections := flag.Int("connections", 100, "websocket subscribers")
	publishers := flag.Int("publishers", 4, "http publisher workers")
	duration := flag.Duration("duration", 30*time.Second, "test duration")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()

	var received uint64
	var published uint64
	var wg sync.WaitGroup

	for i := 0; i < *connections; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			query := url.Values{"topics": []string{*topic}}
			if *token != "" {
				query.Set("token", *token)
			}
			u := url.URL{Scheme: "ws", Host: *addr, Path: "/ws", RawQuery: query.Encode()}
			conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
			if err != nil {
				log.Printf("dial failed: %v", err)
				return
			}
			defer conn.Close()
			for ctx.Err() == nil {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
				atomic.AddUint64(&received, 1)
			}
		}()
	}

	client := &http.Client{Timeout: 5 * time.Second}
	for i := 0; i < *publishers; i++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			endpoint := "http://" + *addr + "/v1/topics/" + url.PathEscape(*topic) + "/messages"
			for ctx.Err() == nil {
				body, _ := json.Marshal(map[string]any{
					"data": map[string]any{"worker": worker, "ts": time.Now().UnixNano()},
				})
				req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				if *token != "" {
					req.Header.Set("Authorization", "Bearer "+*token)
				}
				resp, err := client.Do(req)
				if err == nil {
					_ = resp.Body.Close()
					if resp.StatusCode < 300 {
						atomic.AddUint64(&published, 1)
					}
				}
			}
		}(i)
	}

	<-ctx.Done()
	wg.Wait()

	log.Printf("published=%d received=%d fanout_ratio=%.2f", published, received, float64(received)/max(float64(published), 1))
}

func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

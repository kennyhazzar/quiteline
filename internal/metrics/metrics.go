package metrics

import "github.com/prometheus/client_golang/prometheus"

type Registry struct {
	Prometheus          *prometheus.Registry
	WSConnections       prometheus.Gauge
	MessagesPublished   prometheus.Counter
	MessagesDelivered   prometheus.Counter
	MessagesDropped     prometheus.Counter
	BrokerPublishErrors prometheus.Counter
}

func NewRegistry() *Registry {
	reg := prometheus.NewRegistry()
	m := &Registry{
		Prometheus: prometheus.NewRegistry(),
		WSConnections: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ws_connections",
			Help: "Current WebSocket connections.",
		}),
		MessagesPublished: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "messages_published_total",
			Help: "Messages accepted by the publish API or WebSocket publisher.",
		}),
		MessagesDelivered: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "messages_delivered_total",
			Help: "Messages enqueued to local WebSocket clients.",
		}),
		MessagesDropped: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "messages_dropped_total",
			Help: "Messages dropped because a local WebSocket client was too slow.",
		}),
		BrokerPublishErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "broker_publish_errors_total",
			Help: "Broker publish failures.",
		}),
	}
	reg.MustRegister(m.WSConnections, m.MessagesPublished, m.MessagesDelivered, m.MessagesDropped, m.BrokerPublishErrors)
	m.Prometheus = reg
	return m
}

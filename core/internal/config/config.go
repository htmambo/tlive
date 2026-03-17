package config

import (
	"os"

	"github.com/pelletier/go-toml/v2"
)

// Config is the top-level configuration for TermLive.
type Config struct {
	Daemon DaemonConfig `toml:"daemon"`
	Server ServerConfig `toml:"server"`
}

// DaemonConfig holds settings for the background daemon process.
type DaemonConfig struct {
	Port      int    `toml:"port"`
	Token     string `toml:"token"`
	AutoStart bool   `toml:"auto_start"`
}

// ServerConfig holds settings for the HTTP/WebSocket server.
type ServerConfig struct {
	Port int    `toml:"port"`
	Host string `toml:"host"`
}

// Default returns a Config with sensible defaults.
func Default() *Config {
	return &Config{
		Daemon: DaemonConfig{Port: 8080},
		Server: ServerConfig{Port: 8080, Host: "0.0.0.0"},
	}
}

// LoadFromFile reads a TOML config from path, falling back to defaults.
func LoadFromFile(path string) (*Config, error) {
	cfg := Default()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}
	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

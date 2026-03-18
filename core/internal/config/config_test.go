package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	cfg := Default()
	if cfg.Server.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Server.Port)
	}
	if cfg.Server.Host != "0.0.0.0" {
		t.Errorf("expected default host 0.0.0.0, got %s", cfg.Server.Host)
	}
}

func TestLoadFromFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	content := []byte(`
[server]
port = 3000
host = "127.0.0.1"
`)
	if err := os.WriteFile(cfgPath, content, 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadFromFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 3000 {
		t.Errorf("expected port 3000, got %d", cfg.Server.Port)
	}
	if cfg.Server.Host != "127.0.0.1" {
		t.Errorf("expected host 127.0.0.1, got %s", cfg.Server.Host)
	}
}

func TestLoadFromFileMissing(t *testing.T) {
	cfg, err := LoadFromFile("/nonexistent/config.toml")
	if err != nil {
		t.Fatal("missing file should return defaults, not error")
	}
	if cfg.Server.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Server.Port)
	}
}

func TestLoadFromFile_WithDaemonConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".tlive.toml")
	content := `
[daemon]
port = 9090
token = "my-token"
`
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := LoadFromFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Daemon.Port != 9090 {
		t.Fatalf("expected daemon port 9090, got %d", cfg.Daemon.Port)
	}
	if cfg.Daemon.Token != "my-token" {
		t.Fatalf("expected token 'my-token', got %q", cfg.Daemon.Token)
	}
}

func TestDefault_HasSaneDefaults(t *testing.T) {
	cfg := Default()
	if cfg.Daemon.Port != 8080 {
		t.Fatalf("expected default daemon port 8080, got %d", cfg.Daemon.Port)
	}
}

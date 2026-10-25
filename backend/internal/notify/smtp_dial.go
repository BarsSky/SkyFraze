package notify

// smtp_dial.go — соединение с почтовым сервером.
//
// Два режима, потому что они mutually exclusive у провайдеров: 465 — TLS сразу, 587 и 25 —
// открытый текст, внутри которого сервер предлагает STARTTLS. Смешать их нельзя: попытка
// TLS на 587 повесит соединение до таймаута, а STARTTLS на 465 не состоится вовсе.

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"time"
)

const smtpTimeout = 20 * time.Second

// dialTLS — соединение сразу по TLS (порт 465).
func dialTLS(ctx context.Context, addr, host string) (*smtp.Client, error) {
	dialer := &tls.Dialer{Config: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("notify: соединение с %s: %w", addr, err)
	}
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("notify: smtp greet: %w", err)
	}
	return client, nil
}

// dialPlain — открытое соединение и STARTTLS, если сервер его предлагает.
//
// Если сервер STARTTLS не умеет (локальный MTA, тестовый сервер), соединение остаётся
// открытым: на стенде, где почта ходит по localhost, шифровать нечего, а требование TLS
// сломало бы отправку.
func dialPlain(ctx context.Context, addr, host, _, _ string) (*smtp.Client, error) {
	conn, err := (&net.Dialer{Timeout: smtpTimeout}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("notify: соединение с %s: %w", addr, err)
	}
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("notify: smtp greet: %w", err)
	}
	if ok, _ := client.Extension("STARTTLS"); ok {
		if err := client.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err != nil {
			client.Close()
			return nil, fmt.Errorf("notify: starttls: %w", err)
		}
	}
	return client, nil
}

package collab

// ack_test.go — кадр правки и подтверждение (0.140.0).
//
// Проверяем формат, а не транспорт: обрезанный кадр не должен применяться (иначе сервер
// применил бы чужие байты и подтвердил их клиенту), номер обязан возвращаться ровно тем же,
// а подтверждение — собираться без самого апдейта, чтобы клиент не принял его за правку.

import (
	"bytes"
	"testing"
)

// updateFrame собирает кадр правки так же, как это делает клиент.
func updateFrame(id string, payload []byte) []byte {
	frame := make([]byte, 0, len(updatePrefix)+len(id)+len(payload))
	frame = append(frame, updatePrefix...)
	frame = append(frame, id...)
	return append(frame, payload...)
}

func TestSplitUpdateFrame(t *testing.T) {
	payload := []byte{0x01, 0x02, 0x03, 0x04}
	id, inner, ok := splitUpdateFrame(updateFrame("0000000a", payload))
	if !ok {
		t.Fatal("годный кадр не разобран")
	}
	if string(id) != "0000000a" {
		t.Fatalf("номер правки: %q", id)
	}
	if !bytes.Equal(inner, payload) {
		t.Fatalf("апдейт: %v, ожидался %v", inner, payload)
	}
}

func TestSplitUpdateFrameRejectsShort(t *testing.T) {
	cases := map[string][]byte{
		"только префикс":       []byte(updatePrefix),
		"номер без апдейта":    updateFrame("0000000a", nil),
		"пустой":               {},
		"голый апдейт клиента": {0x00, 0x01, 0x02},
	}
	for name, frame := range cases {
		if _, _, ok := splitUpdateFrame(frame); ok {
			t.Errorf("%s: кадр принят, хотя применять его нельзя", name)
		}
	}
}

func TestAckFrame(t *testing.T) {
	frame := ackFrame([]byte("0000000a"))
	if !bytes.HasPrefix(frame, []byte(ackPrefix)) {
		t.Fatalf("нет префикса подтверждения: %q", frame)
	}
	if got := string(frame[len(ackPrefix):]); got != "0000000a" {
		t.Fatalf("номер в подтверждении: %q", got)
	}
}

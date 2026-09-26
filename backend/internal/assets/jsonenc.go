package assets

import (
	"encoding/json"
	"io"
)

func newJSONEnc(w io.Writer) *json.Encoder { return json.NewEncoder(w) }

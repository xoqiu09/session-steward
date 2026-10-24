package core

import (
	"database/sql"
	"encoding/json"
)

type sqlTx = sql.Tx

func jsonUnmarshal(b []byte, v any) { json.Unmarshal(b, v) }

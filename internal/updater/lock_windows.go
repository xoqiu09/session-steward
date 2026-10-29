package updater

import "errors"

func Lock(home string) (func(), error) { return nil, errors.New("App updates require macOS") }

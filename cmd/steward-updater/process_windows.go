package main

import "errors"

func processAlive(pid int) bool      { return true }
func systemVersion() ([]byte, error) { return nil, errors.New("macOS only") }

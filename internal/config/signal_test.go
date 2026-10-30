package config

import "testing"

func TestSignalGapConfigurationDefaultsAndPreservesOwnerChoice(t *testing.T) {
	if Default().SignalGapAfterMin != 30 {
		t.Fatal("signal gap default must be 30 minutes")
	}
	for _, test := range []struct {
		json string
		want int
	}{{`{}`, 30}, {`{"signal_gap_after_min":0}`, 30}, {`{"signal_gap_after_min":-1}`, 30}, {`{"signal_gap_after_min":45}`, 45}} {
		writeConfig(t, test.json)
		cfg, err := Load()
		if err != nil || cfg.SignalGapAfterMin != test.want {
			t.Fatalf("%s => %d %v", test.json, cfg.SignalGapAfterMin, err)
		}
	}
}

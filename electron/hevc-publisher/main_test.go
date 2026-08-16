package main

import (
	"bytes"
	"encoding/hex"
	"io"
	"testing"
)

func TestHKDFSHA256RFC5869Case1(t *testing.T) {
	ikm := bytes.Repeat([]byte{0x0b}, 22)
	salt, _ := hex.DecodeString("000102030405060708090a0b0c")
	info, _ := hex.DecodeString("f0f1f2f3f4f5f6f7f8f9")
	want, _ := hex.DecodeString("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
	got, err := hkdfSHA256(ikm, salt, info, 42)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("HKDF mismatch\n got %x\nwant %x", got, want)
	}
}

func TestDeriveFrameKeyUsesConcordAES256Profile(t *testing.T) {
	material := make([]byte, 32)
	for i := range material {
		material[i] = byte(i)
	}
	got, err := deriveFrameKey(material)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 32 {
		t.Fatalf("derived key has %d bytes, want 32", len(got))
	}
	// Generated independently with WebCrypto HKDF/SHA-256 using the browser
	// worker's salt and 128-byte zero info block.
	const wantHex = "6d0dd7b3d6f4efde47ab9a9e15abde7635c45a13bddf5da15eed01f40178d328"
	if hex.EncodeToString(got) != wantHex {
		t.Fatalf("derived key = %x, want %s", got, wantHex)
	}
}

func TestConcordKeyProviderReturnsAES256Key(t *testing.T) {
	want := bytes.Repeat([]byte{0x5a}, 32)
	provider := &concordKeyProvider{key: want}
	got, err := provider.GetKey(0)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("provider key mismatch")
	}
	got[0] = 0
	if provider.key[0] != 0x5a {
		t.Fatal("provider returned its mutable key storage")
	}
	if _, err := provider.GetKey(1); err == nil {
		t.Fatal("missing key index unexpectedly succeeded")
	}
}

func TestCountingReadCloserCountsEncodedBytes(t *testing.T) {
	reader := &countingReadCloser{ReadCloser: io.NopCloser(bytes.NewReader([]byte("encoded-hevc")))}
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "encoded-hevc" {
		t.Fatalf("read %q", got)
	}
	if reader.bytes.Load() != uint64(len(got)) {
		t.Fatalf("counted %d bytes, want %d", reader.bytes.Load(), len(got))
	}
}

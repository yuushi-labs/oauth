// Command rp-e2e is a second relying party used to verify interoperability of the provider with a
// different OIDC stack (coreos/go-oidc3) than the Node client used in the main e2e suite.
//
// It performs a full authorization code + PKCE login against a running provider and prints the
// verified claims as JSON on stdout. The caller drives the consent interaction with an HTTP client
// and passes the resulting authorization code via flags.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type result struct {
	Issuer         string                 `json:"issuer"`
	Subject        string                 `json:"sub"`
	Email          string                 `json:"email"`
	EmailVerified  bool                   `json:"email_verified"`
	Username       string                 `json:"preferred_username"`
	Name           string                 `json:"name"`
	IDTokenClaims  map[string]interface{} `json:"id_token_claims"`
	AccessTokenTTL int                    `json:"access_token_ttl"`
	Userinfo       map[string]interface{} `json:"userinfo"`
}

func main() {
	var (
		issuer     = flag.String("issuer", "", "provider issuer URL")
		clientID   = flag.String("client-id", "", "registered client id")
		secret     = flag.String("client-secret", "", "client secret (confidential client)")
		redirect   = flag.String("redirect-uri", "", "registered redirect URI")
		code       = flag.String("code", "", "authorization code")
		verifier   = flag.String("code-verifier", "", "PKCE code verifier")
		nonceParam = flag.String("nonce", "", "nonce sent on the authorization request and expected in the ID Token")
		scopesParam = flag.String("scopes", "openid profile email", "space separated scopes to request")
	)
	flag.Parse()

	if *issuer == "" || *clientID == "" || *redirect == "" || *code == "" || *verifier == "" {
		fmt.Fprintln(os.Stderr, "issuer, client-id, redirect-uri, code and code-verifier are required")
		os.Exit(2)
	}
	if *nonceParam == "" {
		fmt.Fprintln(os.Stderr, "nonce is required: the ID Token must echo it so a mismatched token is detectable")
		os.Exit(2)
	}

	if err := run(*issuer, *clientID, *secret, *redirect, *code, *verifier, *nonceParam, *scopesParam); err != nil {
		fmt.Fprintln(os.Stderr, "interop failure:", err)
		os.Exit(1)
	}
}

func run(issuer, clientID, secret, redirect, code, verifier, nonce, scopes string) error {
	ctx := context.Background()

	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return fmt.Errorf("discovery: %w", err)
	}

	requested := strings.Fields(scopes)
	if len(requested) == 0 {
		requested = []string{oidc.ScopeOpenID}
	}
	oauthConfig := oauth2.Config{
		ClientID:     clientID,
		ClientSecret: secret,
		Endpoint:     provider.Endpoint(),
		RedirectURL:  redirect,
		Scopes:       requested,
	}

	token, err := oauthConfig.Exchange(ctx, code, oauth2.SetAuthURLParam("code_verifier", verifier))
	if err != nil {
		return fmt.Errorf("code exchange: %w", err)
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return fmt.Errorf("provider did not return an id_token")
	}

	// go-oidc3 verifies the signature against JWKS and the audience against the client id.
	idToken, err := provider.Verifier(&oidc.Config{ClientID: clientID}).Verify(ctx, rawIDToken)
	if err != nil {
		return fmt.Errorf("id_token verification: %w", err)
	}

	var claims map[string]interface{}
	if err := idToken.Claims(&claims); err != nil {
		return fmt.Errorf("id_token claims: %w", err)
	}

	userinfo, err := provider.UserInfo(ctx, oauth2.StaticTokenSource(token))
	if err != nil {
		return fmt.Errorf("userinfo: %w", err)
	}
	var userinfoClaims map[string]interface{}
	if err := userinfo.Claims(&userinfoClaims); err != nil {
		return fmt.Errorf("userinfo claims: %w", err)
	}

	// The nonce is echoed into the ID Token, so a mismatch proves the token belongs to this request.
	if idToken.Nonce != nonce {
		return fmt.Errorf("nonce mismatch: want %q got %q", nonce, idToken.Nonce)
	}

	out := result{
		Issuer:         issuer,
		Subject:        idToken.Subject,
		Email:          stringClaim(claims, "email"),
		EmailVerified:  boolClaim(claims, "email_verified"),
		Username:       stringClaim(claims, "preferred_username"),
		Name:           stringClaim(claims, "name"),
		IDTokenClaims:  claims,
		AccessTokenTTL: int(time.Until(token.Expiry).Seconds()),
		Userinfo:       userinfoClaims,
	}
	encoded, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return fmt.Errorf("encode result: %w", err)
	}
	fmt.Println(string(encoded))
	return nil
}

func stringClaim(claims map[string]interface{}, key string) string {
	if value, ok := claims[key].(string); ok {
		return value
	}
	return ""
}

func boolClaim(claims map[string]interface{}, key string) bool {
	if value, ok := claims[key].(bool); ok {
		return value
	}
	return false
}

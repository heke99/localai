# DIV3RSA Supabase Auth email templates

Production sender for all Supabase Auth emails:

- Sender name: `DIV3RSA`
- Sender email: `system@div3rsa.com`
- Site URL: `https://system.div3rsa.com`
- SMTP provider: Resend

The application owns the token exchange endpoint at `/auth/confirm`. Auth emails should use `TokenHash` and send users through that endpoint so the server establishes the Supabase session before redirecting.

## Invite user

Subject:

`Din åtkomst till DIV3RSA är godkänd`

HTML:

```html
<h2>Din åtkomst är godkänd</h2>
<p>Du har fått åtkomst till DIV3RSA.</p>
<p>Bekräfta din e-postadress för att fortsätta skapa ditt konto.</p>
<p>
  <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/auth/accepted">
    Bekräfta e-postadress
  </a>
</p>
<p>Om du inte förväntade dig den här inbjudan kan du ignorera mailet.</p>
```

## Reset password / first password

This one template supports both onboarding and normal password recovery. The application supplies a same-origin `redirectTo` ending in either `?mode=onboarding` or `?mode=recovery`. Keep `{{ .RedirectTo }}` in the template instead of hard-coding one mode.

Subject:

`Skapa eller återställ ditt lösenord`

HTML:

```html
<h2>Välj ett nytt lösenord</h2>
<p>Följ länken nedan för att välja ett nytt lösenord för ditt DIV3RSA-konto.</p>
<p>
  <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next={{ .RedirectTo }}">
    Välj nytt lösenord
  </a>
</p>
<p>Om du inte begärde detta kan du ignorera mailet.</p>
```

Expected application redirect targets:

- First password after approved invite: `https://system.div3rsa.com/auth/set-password?mode=onboarding`
- Forgot password: `https://system.div3rsa.com/auth/set-password?mode=recovery`

## Confirm signup

Public signup is not the normal onboarding path, but keep the template safe and compatible.

Subject:

`Bekräfta din e-postadress`

HTML:

```html
<h2>Bekräfta din e-postadress</h2>
<p>
  <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/auth/accepted">
    Bekräfta e-postadress
  </a>
</p>
```

## Supabase URL configuration

Site URL:

`https://system.div3rsa.com`

Redirect URLs:

- `https://system.div3rsa.com/auth/accepted`
- `https://system.div3rsa.com/auth/set-password`
- `https://system.div3rsa.com/auth/set-password?mode=onboarding`
- `https://system.div3rsa.com/auth/set-password?mode=recovery`

## Security requirements

- Resend click tracking: OFF
- Resend open tracking: OFF
- Email confirmation: ON
- Leaked password protection: ON before external production access
- Keep Supabase Auth email rate limits enabled
- Never expose `SUPABASE_SECRET_KEY` to the browser

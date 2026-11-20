require "openssl"

# Check the Usher-Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
def verify_usher_webhook(secret, body, header, tolerance: 300)
  return false if header.nil? || header.empty?
  parts = header.split(",").to_h { |p| p.split("=", 2) }
  t, signature = parts["t"].to_s, parts["v1"].to_s
  return false unless t.match?(/\A\d+\z/) && (Time.now.to_i - t.to_i).abs <= tolerance
  expected = OpenSSL::HMAC.hexdigest("SHA256", secret, "#{t}.#{body}")
  OpenSSL.secure_compare(expected, signature)
end

# Rails: verify_usher_webhook(SECRET, request.raw_post, request.headers["Usher-Signature"])

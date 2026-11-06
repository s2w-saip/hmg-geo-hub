"""A code table both servers read: the hub server checks an account's regions against it, the data server narrows reads with it."""
from __future__ import annotations

# lib/rhq/_data/rhq-map.json: RHQ region id -> ISO countries (definition order).
RHQ_REGION_COUNTRIES: dict[str, tuple[str, ...]] = {
    "hyundai-europe": ("AL", "AM", "AT", "AZ", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "GE", "DE", "GR", "HU", "IS", "IE", "IT", "KZ", "KG", "LV", "LT", "LU", "MK", "MT", "MD", "NL", "NO", "PL", "PT", "RO", "RU", "RS", "SK", "SI", "ES", "SE", "CH", "TJ", "TM", "TR", "GB", "UA", "UZ"),
    "hyundai-asia-pacific": ("AS", "AU", "BD", "BT", "BN", "KH", "CN", "TL", "FM", "FJ", "PF", "GU", "HK", "IN", "ID", "JP", "KR", "LA", "MO", "MY", "MH", "MN", "MM", "NP", "NC", "NZ", "PH", "MP", "SG", "SB", "LK", "TH", "TO", "VU", "VN", "WS"),
    "hyundai-latin-america": ("AG", "AR", "AW", "BS", "BB", "BM", "BO", "BR", "KY", "CL", "CO", "CR", "CU", "CW", "DO", "EC", "SV", "GF", "GD", "GP", "GT", "GY", "HT", "HN", "JM", "MQ", "NI", "PA", "PY", "PE", "PR", "KN", "LC", "MF", "VC", "SR", "TT", "UY", "VE"),
    "hyundai-africa": ("DZ", "AO", "BJ", "BF", "CM", "CF", "TD", "CG", "CD", "DJ", "EG", "ET", "GM", "GH", "GN", "GW", "CI", "KE", "LR", "LY", "MG", "ML", "MR", "MU", "MA", "MZ", "NE", "NG", "RE", "RW", "SN", "SC", "SL", "ZA", "SD", "TG", "TN", "ZM", "ZW"),
    "hyundai-middle-east": ("AF", "BH", "IQ", "IL", "JO", "KW", "LB", "OM", "PK", "PS", "QA", "SA", "AE", "YE"),
    "hyundai-north-america": ("CA", "MX", "US"),
    "kia-asia-pacific": ("AU", "BD", "BT", "BN", "KH", "CN", "FJ", "HK", "IN", "ID", "JP", "KR", "LA", "MO", "MY", "MN", "MM", "NP", "NZ", "PK", "PH", "SG", "LK", "TW", "TH", "VN", "SB"),
    "kia-western-europe": ("AT", "BE", "CZ", "DK", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT", "LU", "MT", "NL", "NO", "PL", "SK", "PT", "ES", "SE", "CH", "GB"),
    "kia-eastern-europe": ("AM", "AZ", "BY", "BA", "BG", "HR", "CY", "EE", "GE", "KZ", "XK", "KG", "LV", "LT", "MD", "ME", "RO", "RU", "RS", "SI", "TR", "UA", "UZ", "TJ"),
    "kia-middle-east": ("BH", "IL", "JO", "KW", "LB", "IQ", "OM", "PS", "QA", "SA", "AE", "YE", "SY"),
    "kia-africa": ("DZ", "AO", "CM", "EG", "CI", "KE", "MU", "MA", "RE", "SC", "ZA", "SD", "TN", "GH", "LY"),
    "kia-north-america": ("CA", "US"),
    "kia-central-south-america": ("AR", "AW", "BZ", "BO", "BR", "DM", "KY", "CL", "CR", "CW", "CO", "EC", "SV", "GT", "HN", "JM", "MQ", "MX", "NI", "PA", "PY", "PE", "PR", "TT", "UY"),
    "genesis-asia-pacific": ("KR", "AU", "CN", "KZ", "ID"),
    "genesis-middle-east": ("BH", "KW", "OM", "QA", "SA", "AE", "IL"),
    "genesis-north-america": ("CA", "US", "PR"),
    "genesis-europe": ("DE", "GB", "CH", "RU", "NL", "ES", "IT", "FR"),
    "genesis-africa": ("MU", "EG", "TN"),
}

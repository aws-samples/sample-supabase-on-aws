import fs from 'fs'

const RDS_CA_CERT_PATH = process.env['RDS_CA_CERT_PATH'] || '/etc/ssl/certs/rds-global-bundle.pem'

let cachedCert: string | null = null

export function getRdsSslConfig(): { rejectUnauthorized: true; ca: string } | false {
  if (process.env['NODE_ENV'] !== 'production') return false
  if (!cachedCert) {
    cachedCert = fs.readFileSync(RDS_CA_CERT_PATH, 'utf-8')
  }
  return { rejectUnauthorized: true, ca: cachedCert }
}

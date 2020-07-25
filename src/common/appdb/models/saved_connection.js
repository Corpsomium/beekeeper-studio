import path from 'path'
import Crypto from 'crypto'
import { Entity, Column, BeforeInsert, BeforeUpdate } from "typeorm"

import {ApplicationEntity} from './application_entity'
import {EncryptedColumn} from 'typeorm-encrypted-column'
import { resolveHomePathToAbsolute } from '../../utils'
import { loadEncryptionKey } from '../../encryption_key'
import { ConnectionString } from 'connection-string'
import log from 'electron-log'

export const ConnectionTypes = [
  { name: 'MySQL', value: 'mysql' },
  { name: 'MariaDB', value: 'mariadb' },
  { name: 'Postgres', value: 'postgresql' },
  { name: 'SQLite', value: 'sqlite' },
  { name: 'SQL Server', value: 'sqlserver' },
  { name: 'Amazon Redshift', value: 'redshift' },
  { name: 'CockroachDB', value: 'cockroachdb' }
]

function parseConnectionType(t) {
  if (!t) return null

  const mapping = {
    psql: 'postgresql',
    postgres: 'postgresql',
    mssql: 'sqlserver',
  }
  const allowed = ConnectionTypes.map(c => c.value)
  const result = mapping[t] || t
  if (!allowed.includes(result)) return null
  return result
}

export class DbConnectionBase extends ApplicationEntity {

  _connectionType = null

  @Column({ type: 'varchar', name: 'connectionType'})
  set connectionType(value) {
    this._connectionType = parseConnectionType(value)
    if (['mysql', 'mariadb'].includes(this._connectionType)) {
      this.port = 3306
    } else if (this._connectionType === 'postgresql') {
      this.port = 5432
    } else if (this._connectionType === 'sqlserver') {
      this.port = 1433
    } else if (this._connectionType === 'cockroachdb') {
      this.port = 26257
    }
  }

  get connectionType() {
    return this._connectionType
  }

  @Column({type:"varchar", nullable: true})
  host = 'localhost'

  @Column({type: "int", nullable: true})
  port

  @Column({type: "varchar", nullable: true})
  username

  @Column({type: "varchar", nullable: true})
  domain

  @Column({type: "varchar", nullable: true})
  defaultDatabase

  @Column({type: "varchar", nullable: true})
  uri

  @Column({type: "varchar", length: 500, nullable: false})
  uniqueHash = "DEPRECATED"

  @Column({type: 'boolean', nullable: false, default: false})
  sshEnabled = false

  @Column({type: "varchar", nullable: true})
  sshHost

  @Column({type: "int", nullable: true})
  sshPort = 22

  _sshMode = "agent"

  @Column({name: "sshMode", type: "varchar", length: "8", nullable: false, default: "agent"})
  set sshMode(value) {
    this._sshMode = value
    if (!this._sshMode != 'userpass') {
      this.sshPassword = null
    } else if (this._sshMode != 'keyfile') {
      this.sshKeyfile = null
      this.sshKeyfilePassword = null
    }

    if (this._sshMode === 'keyfile' && !this.sshKeyfile) {
      this.sshKeyfile = resolveHomePathToAbsolute("~/.ssh/id_rsa")
    }
  }

  get sshMode() {
    return this._sshMode
  }

  @Column({type: "varchar", nullable: true})
  sshKeyfile = null

  @Column({type: 'varchar', nullable: true})
  sshUsername

  @Column({type: 'varchar', nullable: true})
  sshBastionHost

  @Column({type: 'boolean', nullable: false, default: false})
  ssl

  // GETTERS
  get hash() {
    const str = [
      this.host,
      this.port,
      this.path,
      this.uri,
      this.sshHost,
      this.sshPort,
      this.defaultDatabase,
      this.sshBastionHost
    ].map(part => part || "").join("")
    return Crypto.createHash('md5').update(str).digest('hex')
  }


  get simpleConnectionString() {
    if (this.connectionType === 'sqlite') {
      return path.basename(this.defaultDatabase || "./unknown.db")
    } else {
      return `${this.host}:${this.port}/${this.defaultDatabase}`
    }
  }

  get fullConnectionString() {
    if (this.connectionType === 'sqlite') {
      return this.defaultDatabase || "./unknown.db"
    } else {
      let result = `${this.username || 'user'}@${this.host}:${this.port}/${this.defaultDatabase}`
      if (this.sshHost) {
        result += ` via ${this.sshUsername}@${this.sshHost}`
        if (this.sshBastionHost) result += ` jump(${this.sshBastionHost})`
      }
      return result
    }
  }


}

@Entity({ name: 'saved_connection'} )
export class SavedConnection extends DbConnectionBase {

  @Column("varchar")
  name

  @Column({
    type: 'varchar',
    nullable: true,
    default: null
  })
  labelColor = 'default'

  @Column({type: 'boolean', default: true})
  rememberPassword = true

  @EncryptedColumn({
    type: 'varchar',
    nullable: true,
    encrypt: {
      key: loadEncryptionKey(),
      algorithm: 'aes-256-cbc',
      ivLength: 16,
      looseMatching: false
    }
  })
  password

  @EncryptedColumn({
    type: "varchar",
    nullable: true,
    encrypt: {
      key: loadEncryptionKey(),
      algorithm: 'aes-256-cbc',
      ivLength: 16,
      looseMatching: false
    }
  })
  sshKeyfilePassword

  @EncryptedColumn({
    type: 'varchar',
    nullable: true,
    encrypt: {
      key: loadEncryptionKey(),
      algorithm: 'aes-256-cbc',
      ivLength: 16,
      looseMatching: false
    }
  })
  sshPassword


  parse(url) {
    try {
      const parsed = new ConnectionString(url)
      this.connectionType = parsed.protocol || this.connectionType
      if (parsed.hostname && parsed.hostname.includes('redshift.amazonaws.com')) {
        this.connectionType = 'redshift'
      }
      this.host = parsed.hostname || this.host
      this.port = parsed.port || this.port
      this.username = parsed.user || this.username
      this.password = parsed.password || this.password
      this.defaultDatabase = parsed.path ? parsed.path[0] : null || this.defaultDatabase
      return true
    } catch (ex) {
      log.error("SavedConnection unable to parse connection string", url, ex)
      return false
    }
  }

  @BeforeInsert()
  @BeforeUpdate()
  checkSqlite() {
    if (this.connectionType === 'sqlite' && !this.defaultDatabase) {
      throw new Error("database path must be set for SQLite databases")
    }
  }

  @BeforeInsert()
  @BeforeUpdate()
  maybeClearPasswords() {
    if (!this.rememberPassword) {
      this.password = null
      this.sshPassword = null
      this.rememberSshKeyfilePassword = null
    }
  }

}

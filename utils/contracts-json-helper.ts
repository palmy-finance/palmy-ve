import fs from 'fs'
import jsonfile from 'jsonfile'

export class ContractsJsonHelper {
  static readonly BASE_PATH: string = 'outputs'
  static readonly BASE_NAME: string = 'contracts'
  static readonly EXTENSTION: string = 'json'

  static getFilePath = ({
    network,
    basePath,
    suffix,
  }: {
    network: string
    basePath?: string
    suffix?: string
  }): string => {
    const _basePath = basePath ? basePath : this.BASE_PATH
    const commonFilePath = `${_basePath}/${this.BASE_NAME}-${network}`
    return suffix
      ? `${commonFilePath}-${suffix}.${this.EXTENSTION}`
      : `${commonFilePath}.${this.EXTENSTION}`
  }

  static reset = ({ network }: { network: string }) => {
    const fileName = this.getFilePath({ network })
    if (fs.existsSync(fileName)) {
      const folderName = 'tmp'
      fs.mkdirSync(folderName, { recursive: true })
      // get current datetime in this timezone
      const date = new Date()
      date.setTime(date.getTime() + 9 * 60 * 60 * 1000)
      const strDate = date
        .toISOString()
        .replace(/(-|T|:)/g, '')
        .substring(0, 14)
      // rename current file
      fs.renameSync(
        fileName,
        this.getFilePath({
          network: network,
          basePath: `./tmp`,
          suffix: strDate,
        })
      )
    }
    fs.writeFileSync(fileName, JSON.stringify({}, null, 2), { flag: 'a' })
  }

  static load = ({ network }: { network: string }) => {
    const filePath = this.getFilePath({ network })
    return jsonfile.readFileSync(filePath)
  }

  static _updateJson = ({
    group,
    name,
    value,
    obj,
  }: {
    group: string
    name: string | null
    value: any
    obj: any
  }) => {
    if (obj[group] === undefined) obj[group] = {}
    if (name === null) {
      obj[group] = value
    } else {
      if (obj[group][name] === undefined) obj[group][name] = {}
      obj[group][name] = value
    }
  }

  static writeAddress = ({
    group,
    name,
    value,
    network,
    fileName,
  }: {
    group: string
    name: string | null
    value: string
    network?: string
    fileName?: string
  }) => {
    try {
      if (!network && !fileName) {
        console.error('Need network or fileName...')
        return
      }
      const _fileName =
        fileName ?? this.getFilePath({ network: network as string })
      const base = jsonfile.readFileSync(_fileName)
      this._updateJson({
        group: group,
        name: name,
        value: value,
        obj: base,
      })
      const output = JSON.stringify(base, null, 2)
      fs.writeFileSync(_fileName, output)
    } catch (e) {
      console.log(e)
    }
  }

  static writeValueToGroup = (group: string, value: any, fileName: string) => {
    try {
      const base = jsonfile.readFileSync(fileName)
      this._updateJson({ group: group, name: null, value: value, obj: base })
      const output = JSON.stringify(base, null, 2)
      fs.writeFileSync(fileName, output)
    } catch (e) {
      console.log(e)
    }
  }
}

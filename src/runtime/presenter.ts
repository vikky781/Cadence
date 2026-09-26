export class Presenter {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private dpr = 1
  private width = 0
  private height = 0

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d")
    if (!ctx) {
      throw new Error("Presenter: could not get a 2D rendering context from the canvas.")
    }
    this.canvas = canvas
    this.ctx = ctx
    this.resize()
  }

  // Transform handling: setting canvas.width/height resets the context, but
  // to be robust against repeated resizes (and anything else touching the
  // transform) every draw call starts by resetting the matrix to identity
  // and then re-applying the DPR scale once. Using setTransform (absolute)
  // followed by a single scale means scales can never compound across
  // resizes or draws. All drawing coordinates are in CSS pixels.
  private applyTransform(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.scale(this.dpr, this.dpr)
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1
    this.width = this.canvas.clientWidth
    this.height = this.canvas.clientHeight
    this.canvas.width = Math.round(this.width * this.dpr)
    this.canvas.height = Math.round(this.height * this.dpr)
    this.applyTransform()
  }

  private fill(color: string): void {
    this.applyTransform()
    this.ctx.fillStyle = color
    this.ctx.fillRect(0, 0, this.width, this.height)
  }

  private fontSize(): number {
    return Math.max(16, Math.round(Math.min(this.width, this.height) * 0.1))
  }

  private drawCenteredText(text: string, color: string): void {
    this.ctx.fillStyle = color
    this.ctx.font = `${this.fontSize()}px sans-serif`
    this.ctx.textAlign = "center"
    this.ctx.textBaseline = "middle"
    this.ctx.fillText(text, this.width / 2, this.height / 2)
  }

  drawFixation(): void {
    this.fill("#808080")
    const cx = this.width / 2
    const cy = this.height / 2
    const arm = Math.max(8, Math.min(this.width, this.height) * 0.04)

    this.ctx.strokeStyle = "#000000"
    this.ctx.lineWidth = Math.max(2, arm / 5)
    this.ctx.beginPath()
    this.ctx.moveTo(cx - arm, cy)
    this.ctx.lineTo(cx + arm, cy)
    this.ctx.moveTo(cx, cy - arm)
    this.ctx.lineTo(cx, cy + arm)
    this.ctx.stroke()
  }

  drawText(text: string): void {
    this.fill("#ffffff")
    this.drawCenteredText(text, "#000000")
  }

  drawImage(bitmap: ImageBitmap): void {
    this.fill("#ffffff")
    const scale = Math.min(this.width / bitmap.width, this.height / bitmap.height)
    const drawWidth = bitmap.width * scale
    const drawHeight = bitmap.height * scale
    this.ctx.drawImage(
      bitmap,
      (this.width - drawWidth) / 2,
      (this.height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    )
  }

  drawBlank(): void {
    this.fill("#ffffff")
  }

  drawFeedback(correct: boolean): void {
    this.fill("#ffffff")
    this.drawCenteredText(correct ? "Correct" : "Incorrect", correct ? "#16a34a" : "#dc2626")
  }
}

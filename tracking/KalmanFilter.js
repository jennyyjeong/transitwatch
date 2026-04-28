/**
 * 1D 칼만 필터 (1D Kalman Filter)
 *
 * 칼만 필터는 노이즈가 섞인 GPS 측정값을 부드럽게 만들어주는 알고리즘.
 *
 * 핵심 아이디어 (2가지만 기억하면 됨):
 *   1. 예측(predict): 시간이 지나면 불확실성이 커진다
 *   2. 업데이트(update): 새 측정값이 오면 불확실성이 줄어든다
 *
 * 위도(lat)와 경도(lng)를 각각 독립적인 1D 필터로 처리하면
 * 행렬 연산 없이 사칙연산만으로 구현 가능.
 */
export default class KalmanFilter {
  /**
   * @param {number} processNoise     - 시간이 지나면서 쌓이는 불확실성 (클수록 변화가 크다고 가정)
   * @param {number} measurementNoise - GPS 측정의 부정확도 (클수록 GPS를 덜 신뢰)
   */
  constructor(processNoise = 0.0001, measurementNoise = 0.001) {
    this.estimate = null;       // 현재 추정값 (위도 or 경도)
    this.uncertainty = 1.0;     // 추정값에 대한 불확실성
    this.processNoise = processNoise;
    this.measurementNoise = measurementNoise;
  }

  /**
   * 예측 단계: 시간이 dt초 지났으므로 불확실성이 커진다.
   * 추정값 자체는 바꾸지 않는다 (속도 모델 없이 단순하게).
   *
   * @param {number} dt - 경과 시간 (초)
   */
  predict(dt) {
    // 시간이 지날수록 불확실성 증가
    this.uncertainty += this.processNoise * dt;
  }

  /**
   * 업데이트 단계: 새 GPS 측정값이 왔을 때 추정값을 보정한다.
   *
   * 칼만 이득(gain) = 불확실성 / (불확실성 + 측정 노이즈)
   *   - gain이 1에 가까움 -> 측정값을 더 신뢰 (불확실성이 클 때)
   *   - gain이 0에 가까움 -> 기존 추정값을 더 신뢰 (불확실성이 작을 때)
   *
   * @param {number} measurement - 새 GPS 좌표값
   */
  update(measurement) {
    // 첫 측정값이면 그대로 초기화
    if (this.estimate === null) {
      this.estimate = measurement;
      this.uncertainty = this.measurementNoise;
      return;
    }

    // 칼만 이득 계산
    const gain = this.uncertainty / (this.uncertainty + this.measurementNoise);

    // 추정값 보정: 기존 추정값 + gain * (측정값 - 추정값)
    this.estimate = this.estimate + gain * (measurement - this.estimate);

    // 불확실성 감소: 측정값을 받았으니까 더 확신이 생김
    this.uncertainty = (1 - gain) * this.uncertainty;
  }

  /**
   * 현재 추정값 반환
   * @returns {number|null}
   */
  getEstimate() {
    return this.estimate;
  }

  /**
   * 현재 불확실성 반환
   * @returns {number}
   */
  getUncertainty() {
    return this.uncertainty;
  }
}

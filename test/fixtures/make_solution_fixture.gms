* Generates solution.gdx: a solution with records outside their bounds, binding constraints and levels at bounds.
Set i / i1*i4 /;
Positive Variable x(i) 'flows';
Variable z 'objective';
Binary Variable y(i) 'open';
Equation cap(i) 'capacity', bal 'balance';
cap(i).. x(i) =l= 10;
bal..    sum(i, x(i)) =e= 25;
* x: i1 basic, i2 at its lower bound (reduced cost 2), i3 below it by 0.5, i4 above its upper bound by 3.
x.l(i) = 5; x.up(i) = 20;
x.l('i2') = 0; x.m('i2') = 2;
x.l('i3') = -0.5;
x.l('i4') = 23;
z.l = 42;
* y: i1 at its upper bound, i2 at its lower bound, the others never assigned (no records).
y.l('i1') = 1; y.l('i2') = 0; y.m('i2') = 0.5;
* cap: the =L= rows have the bounds -INF and 10. i1 and i4 are binding, i3 exceeds its bound by 1.5.
cap.lo(i) = -inf; cap.up(i) = 10;
cap.l(i) = 4;
cap.l('i1') = 10; cap.m('i1') = -3;
cap.l('i3') = 11.5;
cap.l('i4') = 10; cap.m('i4') = eps;
* bal: an =E= row that is 0.25 short of its right-hand side, with a large marginal.
bal.lo = 25; bal.up = 25; bal.l = 24.75; bal.m = 100;
execute_unload 'solution.gdx', i, x, z, y, cap, bal;

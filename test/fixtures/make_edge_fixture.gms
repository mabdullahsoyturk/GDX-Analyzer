* Generates edge.gdx: labels with separators/quotes/non-ASCII characters, empty symbols and special values.
Set k / 'a,b' 'has, comma', "it's" 'single quote', 'x"y' 'dq label', 'süß' 'ümlaut "text"' /;
Set empty(k) 'empty set';
Parameter p(k) 'special values' / 'a,b' eps, "it's" 1.5e20, 'x"y' 3 /;
Parameter emptyp(k,k) 'no records';
Set t(k,k) 'tuple'; t('a,b',"it's") = yes;
$onUndf
Scalar u 'undefined' / undf /;
